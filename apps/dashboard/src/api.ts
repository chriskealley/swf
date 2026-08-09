import type { PruningPreview, ServiceEvent } from "./types.js";

export class StaleClientError extends Error {
  constructor(readonly receivedVersion: unknown) {
    super(
      `Dashboard API version mismatch (expected 1, received ${String(receivedVersion)})`,
    );
    this.name = "StaleClientError";
  }
}

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export function localServiceEndpoint(value: string): string {
  const base =
    typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin;
  const url = new URL(value || base, base);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(host)
  )
    throw new DashboardApiError(
      "The dashboard only sends credentials to a local HTTP service",
    );
  return url.origin;
}

export function parseEventBlock(block: string): ServiceEvent | undefined {
  let data = "";
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
  }
  if (!data) return undefined;
  const parsed = JSON.parse(data.trim()) as ServiceEvent;
  return Number.isSafeInteger(parsed.id) ? parsed : undefined;
}

export class DashboardApi {
  readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly credential: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!credential.trim())
      throw new DashboardApiError("A service credential is required");
    this.endpoint = localServiceEndpoint(endpoint);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.credential}`);
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      ...init,
      headers,
    });
    const body = (await response.json().catch(() => ({}))) as {
      schemaVersion?: unknown;
      result?: T;
      statusMessage?: string;
      message?: string;
    };
    if (!response.ok)
      throw new DashboardApiError(
        body.statusMessage ??
          body.message ??
          `Service returned HTTP ${response.status}`,
        response.status,
      );
    if (body.schemaVersion !== 1)
      throw new StaleClientError(body.schemaVersion);
    return body.result as T;
  }

  query<T>(
    resource: string,
    input: {
      projectId?: string;
      runId?: string;
      ref?: string;
      raw?: boolean;
    } = {},
  ): Promise<T> {
    const query = new URLSearchParams({ resource });
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.runId) query.set("runId", input.runId);
    if (input.ref) query.set("ref", input.ref);
    if (input.raw) query.set("raw", "true");
    return this.request<T>(`/api/v1/query?${query}`);
  }

  command(command: Record<string, unknown>): Promise<void> {
    return this.request<unknown>("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    }).then(() => undefined);
  }

  previewPruning(
    projectId: string,
    criteria: { ageDays?: number; runId?: string; budgetBytes?: number },
  ): Promise<PruningPreview> {
    return this.request<PruningPreview>("/api/v1/pruning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, criteria }),
    });
  }

  confirmPruning(
    projectId: string,
    confirmationId: string,
  ): Promise<{ pruned: number; bytes: number }> {
    return this.request("/api/v1/pruning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, confirmationId }),
    });
  }

  subscribe(
    onEvent: (event: ServiceEvent) => void,
    onState: (state: "connecting" | "live" | "reconnecting" | "closed") => void,
  ): () => void {
    const controller = new AbortController();
    let lastEventId = 0;
    let delay = 250;
    const run = async () => {
      onState("connecting");
      while (!controller.signal.aborted) {
        try {
          const headers = new Headers({
            authorization: `Bearer ${this.credential}`,
          });
          if (lastEventId) headers.set("last-event-id", String(lastEventId));
          const response = await this.fetcher(
            `${this.endpoint}/api/v1/events`,
            { headers, signal: controller.signal },
          );
          if (!response.ok || !response.body)
            throw new DashboardApiError(
              `Event stream returned HTTP ${response.status}`,
              response.status,
            );
          onState("live");
          delay = 250;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (!controller.signal.aborted) {
            const result = await reader.read();
            if (result.done) break;
            pending += decoder
              .decode(result.value, { stream: true })
              .replace(/\r\n/g, "\n");
            let boundary = pending.indexOf("\n\n");
            while (boundary >= 0) {
              const event = parseEventBlock(pending.slice(0, boundary));
              pending = pending.slice(boundary + 2);
              if (event && event.id > lastEventId) {
                lastEventId = event.id;
                onEvent(event);
              }
              boundary = pending.indexOf("\n\n");
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error instanceof DashboardApiError && error.status === 401) {
            onState("closed");
            break;
          }
        }
        if (!controller.signal.aborted) {
          onState("reconnecting");
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 5_000);
        }
      }
      onState("closed");
    };
    void run();
    return () => controller.abort();
  }
}
