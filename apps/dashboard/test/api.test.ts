import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardApi,
  DashboardApiError,
  StaleClientError,
  parseEventBlock,
} from "../src/api.js";

describe("dashboard API security and compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invokes the browser fetch function with its Window receiver", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== globalThis)
        throw new TypeError(
          "Can only call Window.fetch on instances of Window",
        );
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, result: [] }), {
          status: 200,
        }),
      );
    } as typeof fetch);
    const api = new DashboardApi("http://127.0.0.1:34671", "secret");
    await expect(api.query("projects")).resolves.toEqual([]);
  });

  it("only sends bearer credentials to loopback HTTP services", async () => {
    expect(() => new DashboardApi("https://example.com", "secret")).toThrow(
      DashboardApiError,
    );
    expect(
      () => new DashboardApi("http://192.168.1.10:34671", "secret"),
    ).toThrow(DashboardApiError);
    const requests: RequestInit[] = [];
    const api = new DashboardApi(
      "http://127.0.0.1:34671",
      "secret",
      async (_url, init) => {
        requests.push(init ?? {});
        return new Response(JSON.stringify({ schemaVersion: 1, result: [] }), {
          status: 200,
        });
      },
    );
    await api.query("projects");
    expect(new Headers(requests[0]?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
  });

  it("reports an actionable error when the published service endpoint cannot be reached", async () => {
    const api = new DashboardApi(
      "http://127.0.0.1:34671",
      "secret",
      async () => {
        throw new TypeError("Load failed");
      },
    );
    await expect(api.query("overview")).rejects.toThrow(
      "Cannot reach the SWF service at http://127.0.0.1:34671",
    );
  });

  it("fails clearly when the service API is newer than the client", async () => {
    const api = new DashboardApi(
      "http://localhost:34671",
      "secret",
      async () =>
        new Response(JSON.stringify({ schemaVersion: 2, result: {} }), {
          status: 200,
        }),
    );
    await expect(api.query("overview")).rejects.toBeInstanceOf(
      StaleClientError,
    );
  });

  it("parses ordered SSE data blocks", () => {
    expect(
      parseEventBlock(
        'id: 7\nevent: run.transitioned\ndata: {"id":7,"timestamp":"now","type":"run.transitioned","data":{}}\n',
      ),
    ).toMatchObject({ id: 7, type: "run.transitioned" });
    expect(parseEventBlock(": heartbeat\n")).toBeUndefined();
  });

  it("reconnects the authenticated event stream from the last ordered event", async () => {
    const requests: RequestInit[] = [];
    const encoder = new TextEncoder();
    const event = (id: number) =>
      `id: ${id}\nevent: update\ndata: {"id":${id},"timestamp":"now","type":"update","data":{}}\n\n`;
    let call = 0;
    const api = new DashboardApi(
      "http://127.0.0.1:34671",
      "secret",
      async (_url, init) => {
        requests.push(init ?? {});
        call += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(event(call)));
              controller.close();
            },
          }),
          { status: 200 },
        );
      },
    );
    let stop: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      stop = api.subscribe(
        (update) => {
          if (update.id === 2) {
            stop?.();
            resolve();
          }
        },
        () => undefined,
      );
    });
    expect(new Headers(requests[0]?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
    expect(new Headers(requests[1]?.headers).get("last-event-id")).toBe("1");
  });
});
