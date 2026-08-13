import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertLoopbackHttpEndpoint } from "./security.js";
import type {
  ClassifiedOperatorError,
  OperatorProjection,
} from "./operator-projection.js";

export interface LocalServiceMetadata {
  schemaVersion: 1;
  serviceId: string;
  pid: number;
  endpoint: string;
  credential: string;
  startedAt: string;
}

export interface ServiceStreamEvent {
  id: number;
  timestamp: string;
  type: string;
  projectId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

export function parseServiceEventBlock(
  block: string,
): ServiceStreamEvent | undefined {
  let data = "";
  for (const line of block.split(/\r?\n/))
    if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
  if (!data) return undefined;
  const event = JSON.parse(data.trim()) as ServiceStreamEvent;
  return Number.isSafeInteger(event.id) ? event : undefined;
}

export class ServiceUnavailableError extends Error {
  constructor(
    message = "SWF service is unavailable. Start it with `swf service start`.",
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export class SwfOperatorError extends Error {
  constructor(
    readonly detail: ClassifiedOperatorError,
    readonly projection?: OperatorProjection,
  ) {
    super(detail.message);
    this.name = "SwfOperatorError";
  }
}

function serviceHome(): string {
  return (
    process.env.SWF_SERVICE_HOME ??
    process.env.SWF_CONFIG_HOME ??
    join(process.env.HOME ?? process.cwd(), ".config", "swf")
  );
}

export async function readLocalServiceMetadata(
  home = serviceHome(),
): Promise<LocalServiceMetadata> {
  try {
    const metadata = JSON.parse(
      await readFile(join(home, "service.json"), "utf8"),
    ) as LocalServiceMetadata;
    if (
      metadata.schemaVersion !== 1 ||
      !metadata.endpoint ||
      !metadata.credential
    )
      throw new Error("Invalid service metadata");
    assertLoopbackHttpEndpoint(metadata.endpoint);
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ServiceUnavailableError();
    throw error;
  }
}

export class SwfServiceClient {
  constructor(
    readonly metadata: LocalServiceMetadata,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  static async connect(home?: string): Promise<SwfServiceClient> {
    return new SwfServiceClient(await readLocalServiceMetadata(home));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.metadata.endpoint}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.metadata.credential}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ServiceUnavailableError(
        `Cannot reach SWF service at ${this.metadata.endpoint}: ${error instanceof Error ? error.message : "network failure"}`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as {
      result?: T;
      statusMessage?: string;
      error?: ClassifiedOperatorError;
      projection?: OperatorProjection;
    };
    if (!response.ok && body.error)
      throw new SwfOperatorError(body.error, body.projection);
    if (!response.ok)
      throw new Error(
        body.statusMessage ?? `SWF service returned HTTP ${response.status}`,
      );
    return body.result as T;
  }

  async query<T>(
    resource: string,
    input: {
      projectId?: string;
      runId?: string;
      phaseId?: string;
      ref?: string;
    } = {},
  ): Promise<T> {
    const query = new URLSearchParams({ resource });
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.runId) query.set("runId", input.runId);
    if (input.phaseId) query.set("phaseId", input.phaseId);
    if (input.ref) query.set("ref", input.ref);
    return this.request<T>(`/api/v1/query?${query}`);
  }

  async registerProject(input: {
    projectId: string;
    displayName: string;
    root: string;
  }): Promise<unknown> {
    return this.request<unknown>("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async command<T = unknown>(command: Record<string, unknown>): Promise<T> {
    const childMode = process.env.SWF_CHILD_MODE === "1";
    return this.request<T>("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...command,
        childContext: childMode
          ? {
              childMode: true,
              allowNested: process.env.SWF_ALLOW_NESTED_ORCHESTRATION === "1",
              runId: process.env.SWF_RUN_ID,
              phaseId: process.env.SWF_PHASE_ID,
              invocationId: process.env.SWF_INVOCATION_ID,
            }
          : undefined,
      }),
    });
  }

  async *events(
    input: {
      after?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<ServiceStreamEvent> {
    const headers = new Headers({
      authorization: `Bearer ${this.metadata.credential}`,
    });
    if (input.after) headers.set("last-event-id", String(input.after));
    const response = await this.fetcher(
      `${this.metadata.endpoint}/api/v1/events`,
      { headers, signal: input.signal },
    );
    if (!response.ok || !response.body)
      throw new ServiceUnavailableError(
        `SWF progress stream returned HTTP ${response.status}`,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (!input.signal?.aborted) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder
        .decode(result.value, { stream: true })
        .replace(/\r\n/g, "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseServiceEventBlock(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (event) yield event;
        boundary = pending.indexOf("\n\n");
      }
    }
    if (!input.signal?.aborted)
      throw new ServiceUnavailableError(
        "SWF progress stream ended unexpectedly",
      );
  }

  async previewPruning(
    projectId: string,
    criteria: { ageDays?: number; runId?: string; budgetBytes?: number },
  ): Promise<unknown> {
    return this.request<unknown>("/api/v1/pruning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, criteria }),
    });
  }

  async confirmPruning(
    projectId: string,
    confirmationId: string,
  ): Promise<unknown> {
    return this.request<unknown>("/api/v1/pruning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, confirmationId }),
    });
  }

  async shutdown(force = false): Promise<void> {
    await this.request<unknown>("/api/v1/service", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "shutdown", force }),
    });
  }
}
