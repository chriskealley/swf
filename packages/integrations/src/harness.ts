import { randomUUID } from "node:crypto";
import {
  type AdapterCapabilities,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type HarnessAdapter,
  type HerdrAgentStatus,
  HerdrClient,
} from "@swf/core";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function parseJsonLines(value: string): Array<Record<string, unknown>> {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findString(entry, keys);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      keys.includes(key) &&
      (typeof nested === "string" || typeof nested === "number")
    )
      return String(nested);
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return undefined;
}

export function sessionIdFromEvents(
  events: Array<Record<string, unknown>>,
  transcript: string,
): string | undefined {
  for (const event of events) {
    const id = findString(event, [
      "thread_id",
      "threadId",
      "session_id",
      "sessionId",
    ]);
    if (id) return id;
  }
  return transcript.match(
    /(?:session(?:\s+id)?|thread)[\s:=]+([0-9a-f-]{16,})/i,
  )?.[1];
}

function statusFromHerdr(
  status: HerdrAgentStatus,
): AdapterInvocation["status"] {
  if (status === "working") return "running";
  if (status === "blocked") return "blocked";
  if (status === "idle" || status === "done") return "completed";
  return "unknown";
}

function capabilityKey(value: string): keyof AdapterCapabilities {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  ) as keyof AdapterCapabilities;
}

export abstract class CliHarnessAdapter implements HarnessAdapter {
  abstract readonly id: string;
  abstract readonly executable: string;
  abstract readonly capabilities: AdapterCapabilities;

  constructor(readonly herdr: HerdrClient) {}

  protected abstract launchCommand(request: AdapterLaunchRequest): string;
  protected abstract resumeCommand(
    invocation: AdapterInvocation,
    prompt: string,
  ): string;
  protected abstract usage(
    events: Array<Record<string, unknown>>,
  ): AdapterResult["usage"];

  protected events(transcript: string): Array<Record<string, unknown>> {
    return this.capabilities.structuredEvents ? parseJsonLines(transcript) : [];
  }

  protected async authentication(): Promise<string | undefined> {
    return undefined;
  }

  async availability(): Promise<AdapterValidation> {
    const diagnostics = await this.herdr.diagnostics(
      [this.id],
      [this.executable],
    );
    const errors = [
      ...diagnostics.integrations
        .filter(({ installed }) => !installed)
        .map(({ name }) => `Herdr integration is missing: ${name}`),
      ...diagnostics.harnesses
        .filter(({ available }) => !available)
        .map(
          ({ executable }) => `Harness executable is missing: ${executable}`,
        ),
    ];
    if (!errors.length) {
      const authenticationError = await this.authentication();
      if (authenticationError) errors.push(authenticationError);
    }
    return { valid: errors.length === 0, errors };
  }

  async validate(
    request: Pick<AdapterLaunchRequest, "model" | "tools" | "excludeTools">,
    requiredCapabilities: string[] = [],
  ): Promise<AdapterValidation> {
    const errors: string[] = [];
    for (const capability of requiredCapabilities) {
      const key = capabilityKey(capability);
      if (!(key in this.capabilities) || !this.capabilities[key])
        errors.push(
          `${this.id} does not advertise required capability: ${capability}`,
        );
    }
    if (request.model && !this.capabilities.modelSelection)
      errors.push(`${this.id} does not support model selection`);
    if (
      (request.tools?.length || request.excludeTools?.length) &&
      !this.capabilities.toolSelection
    )
      errors.push(`${this.id} does not support tool selection`);
    if (
      request.tools?.some((tool) => !tool.trim()) ||
      request.excludeTools?.some((tool) => !tool.trim())
    )
      errors.push(`${this.id} tool selections must be non-empty names`);
    return { valid: errors.length === 0, errors };
  }

  async launch(request: AdapterLaunchRequest): Promise<AdapterInvocation> {
    const validation = await this.validate(request);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    const observation = await this.herdr.launch({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      label: `${this.id}-${request.phaseId}-${request.workUnitId}`,
      command: this.launchCommand(request),
      timeoutMs: request.timeoutMs,
    });
    const transcript = await this.herdr.transcript(observation.paneId!, 400);
    const invocation: AdapterInvocation = {
      invocationId: randomUUID(),
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: observation.paneId!,
      status: statusFromHerdr(observation.status),
      startedAt: new Date().toISOString(),
      nativeSessionId: sessionIdFromEvents(this.events(transcript), transcript),
    };
    return invocation;
  }

  async submit(invocation: AdapterInvocation, prompt: string): Promise<void> {
    if (!this.capabilities.resume)
      throw new Error(
        `${this.id} cannot submit a follow-up because resume is unsupported`,
      );
    await this.herdr.submitPrompt(
      invocation.paneId,
      this.resumeCommand(invocation, prompt),
    );
  }

  async observe(invocation: AdapterInvocation): Promise<AdapterObservation> {
    const observation = await this.herdr.observe(invocation.paneId);
    const transcript = await this.herdr.transcript(invocation.paneId, 400);
    return {
      status: statusFromHerdr(observation.status),
      message: observation.message,
      blockedPrompt:
        observation.status === "blocked" ? observation.message : undefined,
      structuredEvents: this.events(transcript),
    };
  }

  async cancel(invocation: AdapterInvocation): Promise<void> {
    await this.herdr.cancel(invocation.paneId);
  }

  async collect(invocation: AdapterInvocation): Promise<AdapterResult> {
    const observation = await this.observe(invocation);
    const transcript = await this.herdr.transcript(invocation.paneId, 2_000);
    const status =
      observation.status === "completed"
        ? "completed"
        : observation.status === "cancelled"
          ? "cancelled"
          : "failed";
    return { status, transcript, usage: this.usage(this.events(transcript)) };
  }
}

export function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function nestedRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
