import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertLoopbackHttpEndpoint } from "./security.js";

export interface LocalServiceMetadata {
  schemaVersion: 1;
  serviceId: string;
  pid: number;
  endpoint: string;
  credential: string;
  startedAt: string;
}

export class ServiceUnavailableError extends Error {
  constructor(
    message = "SWF service is unavailable. Start it with `swf service start`.",
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
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
    };
    if (!response.ok)
      throw new Error(
        body.statusMessage ?? `SWF service returned HTTP ${response.status}`,
      );
    return body.result as T;
  }

  async query<T>(
    resource: string,
    input: { projectId?: string; runId?: string; phaseId?: string } = {},
  ): Promise<T> {
    const query = new URLSearchParams({ resource });
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.runId) query.set("runId", input.runId);
    if (input.phaseId) query.set("phaseId", input.phaseId);
    return this.request<T>(`/api/v1/query?${query}`);
  }

  async command<T = unknown>(command: Record<string, unknown>): Promise<T> {
    return this.request<T>("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
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
