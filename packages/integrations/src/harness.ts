import { randomUUID } from "node:crypto";
import {
  type AdapterCapabilities,
  type AdapterAdoptionRequest,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type HarnessAdapter,
  type HarnessCodec,
  HarnessNormalizedStreamConsumer,
  HarnessProtocolStore,
  harnessBridgeCommand,
  harnessPaneLabel,
  reduceHarnessEvents,
  type HerdrAgentStatus,
  HerdrClient,
  writeHarnessBridgeDescriptor,
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

  private readonly bridgeStores = new Map<string, HarnessProtocolStore>();
  private readonly bridgeConsumers = new Map<
    string,
    HarnessNormalizedStreamConsumer
  >();

  constructor(readonly herdr: HerdrClient) {}

  protected abstract launchCommand(request: AdapterLaunchRequest): string;
  protected abstract resumeCommand(
    invocation: AdapterInvocation,
    prompt: string,
  ): string;
  protected abstract usage(
    events: Array<Record<string, unknown>>,
  ): AdapterResult["usage"];

  protected bridgeCodec(): HarnessCodec | undefined {
    return undefined;
  }

  async adopt(request: AdapterAdoptionRequest): Promise<void> {
    if (!this.bridgeCodec())
      throw new Error(`${this.id} does not support structured bridge adoption`);
    const store = new HarnessProtocolStore(
      request.stateDirectory,
      request.invocation.runId,
      request.invocation.invocationId,
    );
    await store.metadata();
    this.bridgeStores.set(request.invocation.invocationId, store);
    this.bridgeConsumers.set(
      request.invocation.invocationId,
      new HarnessNormalizedStreamConsumer(store),
    );
  }

  protected bridgeLaunchArguments(
    _request: AdapterLaunchRequest,
  ): string[] | undefined {
    return undefined;
  }

  protected bridgeResumeArguments(
    _invocation: AdapterInvocation,
  ): string[] | undefined {
    return undefined;
  }

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
    const codec = this.bridgeCodec();
    const bridgeArguments = this.bridgeLaunchArguments(request);
    if (codec && bridgeArguments)
      return this.launchBridge(request, codec, bridgeArguments);
    const observation = await this.herdr.launch({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      label: `${this.id}-${request.phaseId}-${request.workUnitId}`,
      command: this.launchCommand(request),
      environment: request.environment,
      timeoutMs: request.timeoutMs,
    });
    const transcript = await this.herdr.transcript(observation.paneId!, 400);
    const invocation: AdapterInvocation = {
      invocationId: request.invocationId ?? randomUUID(),
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
    const store = this.bridgeStores.get(invocation.invocationId);
    const bridgeArguments = this.bridgeResumeArguments(invocation);
    if (store && bridgeArguments) {
      const metadata = await store.metadata();
      const descriptorPath = await writeHarnessBridgeDescriptor(store, {
        schemaVersion: 1,
        stateDirectory: store.stateDirectory,
        command: this.executable,
        args: bridgeArguments,
        cwd: metadata.cwd ?? process.cwd(),
        context: {
          projectId: metadata.projectId,
          runId: invocation.runId,
          phaseId: invocation.phaseId,
          workUnitId: invocation.workUnitId,
          invocationId: invocation.invocationId,
          harness: this.id,
          nativeSessionId: invocation.nativeSessionId,
        },
        codecVersion: metadata.codecVersion,
        presentationLevel: metadata.presentationLevel as
          "quiet" | "normal" | "verbose" | "protocol",
        initialInput: { format: "text", value: `${prompt}\n` },
        closeInputAfterInitial: true,
        controlOffset: await store.controlSize(),
      });
      await this.herdr.submitPrompt(
        invocation.paneId,
        harnessBridgeCommand(descriptorPath),
      );
      return;
    }
    await this.herdr.submitPrompt(
      invocation.paneId,
      this.resumeCommand(invocation, prompt),
    );
  }

  async observe(invocation: AdapterInvocation): Promise<AdapterObservation> {
    const store = this.bridgeStores.get(invocation.invocationId);
    if (store) {
      const consumer = this.bridgeConsumers.get(invocation.invocationId);
      if (!consumer)
        throw new Error(
          `No normalized consumer is registered for ${invocation.invocationId}`,
        );
      const { events, state } = await consumer.poll();
      invocation.nativeSessionId = state.nativeSessionId;
      const status =
        state.status === "settled"
          ? "completed"
          : state.status === "failed"
            ? "failed"
            : state.status === "cancelled"
              ? "cancelled"
              : state.status === "blocked"
                ? "blocked"
                : "running";
      invocation.status = status;
      await this.herdr
        .presentPane(
          invocation.paneId,
          harnessPaneLabel({
            runId: invocation.runId,
            phaseId: invocation.phaseId,
            harness: this.id,
            status,
          }),
        )
        .catch(() => undefined);
      return {
        status,
        message: state.diagnostics.at(-1),
        blockedPrompt: state.blockedPrompt,
        structuredEvents: events as Array<Record<string, unknown>>,
      };
    }
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
    const store = this.bridgeStores.get(invocation.invocationId);
    if (store) {
      await store.appendControl({ action: "cancel" });
      return;
    }
    await this.herdr.cancel(invocation.paneId);
  }

  async collect(invocation: AdapterInvocation): Promise<AdapterResult> {
    const store = this.bridgeStores.get(invocation.invocationId);
    if (store) {
      const observation = await this.observe(invocation);
      const events = await store.events();
      const status =
        observation.status === "completed"
          ? "completed"
          : observation.status === "cancelled"
            ? "cancelled"
            : "failed";
      return {
        status,
        transcript: events.map((event) => JSON.stringify(event)).join("\n"),
        usage: [...events].reverse().find(({ usage }) => usage)?.usage ?? {
          quality: "unknown",
        },
      };
    }
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

  private async launchBridge(
    request: AdapterLaunchRequest,
    codec: HarnessCodec,
    args: string[],
  ): Promise<AdapterInvocation> {
    if (!request.stateDirectory || !request.projectId)
      throw new Error(
        `${this.id} bridge launch requires projectId and stateDirectory`,
      );
    const invocationId = request.invocationId ?? randomUUID();
    const store = new HarnessProtocolStore(
      request.stateDirectory,
      request.runId,
      invocationId,
    );
    const descriptorPath = await writeHarnessBridgeDescriptor(store, {
      schemaVersion: 1,
      stateDirectory: request.stateDirectory,
      command: this.executable,
      args,
      cwd: request.cwd,
      environment: request.environment,
      context: {
        projectId: request.projectId,
        runId: request.runId,
        phaseId: request.phaseId,
        workUnitId: request.workUnitId,
        invocationId,
        harness: this.id,
      },
      codecVersion: codec.version,
      presentationLevel: request.presentationLevel ?? "normal",
      initialInput: { format: "text", value: `${request.prompt}\n` },
      closeInputAfterInitial: true,
      controlOffset: await store.controlSize(),
    });
    const observation = await this.herdr.launch({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      label: harnessPaneLabel({
        runId: request.runId,
        phaseId: request.phaseId,
        harness: this.id,
        status: "starting",
      }),
      command: harnessBridgeCommand(descriptorPath),
      environment: request.environment,
      timeoutMs: request.timeoutMs,
    });
    this.bridgeStores.set(invocationId, store);
    const consumer = new HarnessNormalizedStreamConsumer(store);
    this.bridgeConsumers.set(invocationId, consumer);
    const metadata = await store.metadata();
    // Derive launch metadata without advancing the durable service cursor. The
    // first observation must still publish every normalized startup milestone.
    const state = reduceHarnessEvents(await store.events());
    const invocation: AdapterInvocation = {
      invocationId,
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: observation.paneId!,
      workspaceId: observation.workspaceId ?? request.workspaceId,
      tabId: observation.tabId,
      terminalId: observation.terminalId,
      processId: observation.processId,
      ownedProcessIds: [
        observation.processId,
        metadata.bridgePid === undefined
          ? undefined
          : String(metadata.bridgePid),
        metadata.nativePid === undefined
          ? undefined
          : String(metadata.nativePid),
      ].filter((value): value is string => value !== undefined),
      protocolDirectory: store.directory,
      status: state.status === "settled" ? "completed" : "running",
      startedAt: new Date().toISOString(),
      nativeSessionId: state.nativeSessionId,
    };
    await this.herdr
      .presentPane(
        invocation.paneId,
        harnessPaneLabel({
          runId: invocation.runId,
          phaseId: invocation.phaseId,
          harness: this.id,
          status: invocation.status,
        }),
      )
      .catch(() => undefined);
    return invocation;
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
