import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ServiceUnavailableError,
  SwfServiceClient,
  readLocalServiceMetadata,
} from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SWF service client", () => {
  it("uses local credentials for versioned query and command requests", async () => {
    const home = await mkdtemp(join(tmpdir(), "swf-client-"));
    directories.push(home);
    await writeFile(
      join(home, "service.json"),
      JSON.stringify({
        schemaVersion: 1,
        serviceId: "s",
        pid: 1,
        endpoint: "http://swf.test",
        credential: "secret",
        startedAt: "2026-04-02T12:00:00.000Z",
      }),
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SwfServiceClient(
      await readLocalServiceMetadata(home),
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ schemaVersion: 1, result: { ok: true } }),
          { status: 200 },
        );
      },
    );
    await expect(
      client.query("run", { projectId: "p", runId: "r" }),
    ).resolves.toEqual({ ok: true });
    await client.command({ type: "pause", projectId: "p", runId: "r" });
    expect(calls).toMatchObject([
      {
        url: "http://swf.test/api/v1/query?resource=run&projectId=p&runId=r",
        init: { headers: { authorization: "Bearer secret" } },
      },
      { url: "http://swf.test/api/v1/commands", init: { method: "POST" } },
    ]);
  });

  it("reports missing service metadata without attempting local state mutation", async () => {
    const home = await mkdtemp(join(tmpdir(), "swf-client-"));
    directories.push(home);
    await expect(readLocalServiceMetadata(home)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});
