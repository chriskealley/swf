import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGED_SERVICE_ENTRY,
  ServiceStartError,
  createServiceLaunchPlan,
  describeLaunchCommand,
  listServiceLogs,
  readServiceLogTail,
  removeStaleServiceMetadata,
  resolvePackagedServiceEntry,
  rotateServiceLog,
  waitForServiceReadiness,
} from "../src/service-launcher.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swf launcher "));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

function healthResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const compatibility = {
  apiProtocolVersion: 1,
  stateSchemaVersion: 1,
  compatibleClientRange: ">=0.1.0 <0.2.0",
  piExtensionRange: ">=0.1.0 <0.2.0",
  minimumNodeVersion: "24.0.0",
};

describe("launch plan", () => {
  it("uses an argument array rather than a command string", () => {
    const plan = createServiceLaunchPlan({
      serviceEntry: "/opt/my product/service/server/index.mjs",
      serviceHome: "/opt/home",
      port: 34671,
    });
    expect(plan.args).toEqual(["/opt/my product/service/server/index.mjs"]);
    expect(plan.executable).toBe(process.execPath);
  });

  it("pins the host to loopback so the service is never network-reachable", () => {
    const plan = createServiceLaunchPlan({
      serviceEntry: "/entry.mjs",
      serviceHome: "/home",
      port: 5000,
    });
    expect(plan.environment.HOST).toBe("127.0.0.1");
    expect(plan.environment.NITRO_HOST).toBe("127.0.0.1");
    expect(plan.endpoint).toBe("http://127.0.0.1:5000");
  });

  it("isolates both service home variables", () => {
    const plan = createServiceLaunchPlan({
      serviceEntry: "/entry.mjs",
      serviceHome: "/isolated",
      port: 1,
    });
    expect(plan.environment.SWF_SERVICE_HOME).toBe("/isolated");
    expect(plan.environment.SWF_CONFIG_HOME).toBe("/isolated");
  });

  it("quotes only the parts that need it when described", () => {
    const plan = createServiceLaunchPlan({
      serviceEntry: "/opt/my product/index.mjs",
      serviceHome: "/home",
      port: 1,
      nodeExecutable: "/usr/bin/node",
    });
    expect(describeLaunchCommand(plan)).toBe(
      '/usr/bin/node "/opt/my product/index.mjs"',
    );
  });

  it("never launches a package manager or shell", () => {
    const plan = createServiceLaunchPlan({
      serviceEntry: "/entry.mjs",
      serviceHome: "/home",
      port: 1,
    });
    const line = describeLaunchCommand(plan);
    expect(line).not.toContain("pnpm");
    expect(line).not.toContain("--filter");
    expect(line).not.toContain("nitro");
  });
});

describe("packaged entry resolution", () => {
  it("finds the entry above a nested module directory", async () => {
    const root = await workspace();
    const entry = join(root, PACKAGED_SERVICE_ENTRY);
    await mkdir(join(entry, ".."), { recursive: true });
    await writeFile(entry, "export default {};\n");
    await mkdir(join(root, "bin"), { recursive: true });
    expect(await resolvePackagedServiceEntry(join(root, "bin"))).toBe(entry);
  });

  it("returns undefined in a source checkout with no packaged entry", async () => {
    expect(
      await resolvePackagedServiceEntry(await workspace()),
    ).toBeUndefined();
  });
});

describe("log rotation and retention", () => {
  it("leaves a small log in place", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(logPath, "short\n");
    expect(await rotateServiceLog(logPath, { maximumBytes: 1024 })).toBe(false);
  });

  it("rotates once the log exceeds its budget", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(logPath, "x".repeat(2048));
    expect(await rotateServiceLog(logPath, { maximumBytes: 1024 })).toBe(true);
    expect((await stat(`${logPath}.1`)).size).toBe(2048);
  });

  it("retains a bounded number of rotated files", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true });
    for (let round = 0; round < 5; round += 1) {
      await writeFile(logPath, "y".repeat(2048));
      await rotateServiceLog(logPath, {
        maximumBytes: 1024,
        retainedFiles: 2,
      });
    }
    const retained = await listServiceLogs(root);
    expect(retained.length).toBeLessThanOrEqual(3);
  });
});

describe("log inspection", () => {
  it("returns a bounded tail and reports truncation", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(
      logPath,
      Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
    );
    const tail = await readServiceLogTail(logPath, 10);
    expect(tail.lines).toHaveLength(10);
    expect(tail.lines.at(-1)).toBe("line 99");
    expect(tail.truncated).toBe(true);
  });

  it("redacts credentials before showing log content", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(
      logPath,
      "connecting with Authorization: Bearer abc123XYZ_secret-token-value\n",
    );
    const tail = await readServiceLogTail(logPath);
    expect(tail.lines.join("\n")).not.toContain("abc123XYZ_secret-token-value");
    expect(tail.lines.join("\n")).toContain("[REDACTED]");
  });

  it("returns an empty tail for a missing log", async () => {
    const root = await workspace();
    expect(
      (await readServiceLogTail(join(root, "logs", "absent.log"))).lines,
    ).toEqual([]);
  });
});

describe("readiness handshake", () => {
  it("reports ready for a compatible service", async () => {
    const result = await waitForServiceReadiness("http://127.0.0.1:1", {
      attempts: 1,
      fetchImplementation: (async () =>
        healthResponse({ compatibility })) as unknown as typeof fetch,
      clientVersion: "0.1.0",
      clientApiProtocolVersion: 1,
    });
    expect(result.ready).toBe(true);
  });

  it("refuses an incompatible service and explains why", async () => {
    const result = await waitForServiceReadiness("http://127.0.0.1:1", {
      attempts: 1,
      fetchImplementation: (async () =>
        healthResponse({
          compatibility: { ...compatibility, apiProtocolVersion: 9 },
        })) as unknown as typeof fetch,
      clientVersion: "0.1.0",
      clientApiProtocolVersion: 1,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("API protocol");
  });

  it("gives up after its attempt budget when nothing responds", async () => {
    const result = await waitForServiceReadiness("http://127.0.0.1:1", {
      attempts: 2,
      intervalMs: 1,
      fetchImplementation: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("service did not become healthy");
  });

  it("does not treat a listening but unready service as started", async () => {
    // Nitro answers /api/health as soon as the process listens, which happens
    // before SWF claims its state directory.
    const result = await waitForServiceReadiness("http://127.0.0.1:1", {
      attempts: 2,
      intervalMs: 1,
      fetchImplementation: (async () =>
        healthResponse({
          status: "unavailable",
          ready: false,
          reason: "SWF service is already running",
          compatibility,
        })) as unknown as typeof fetch,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("already running");
  });

  it("accepts a service that reports no compatibility metadata but flags it", async () => {
    const result = await waitForServiceReadiness("http://127.0.0.1:1", {
      attempts: 1,
      fetchImplementation: (async () =>
        healthResponse({})) as unknown as typeof fetch,
    });
    expect(result.ready).toBe(true);
    expect(result.reason).toContain("no compatibility metadata");
  });
});

describe("failed start diagnostics", () => {
  it("clears the lock and metadata together", async () => {
    const root = await workspace();
    // A dead owner: a pid that cannot be running.
    const state = JSON.stringify({ pid: 2 ** 22, endpoint: "http://x" });
    await writeFile(join(root, "service.json"), state);
    await writeFile(join(root, "service.lock"), state);
    expect(await removeStaleServiceMetadata(root)).toMatchObject({
      removed: true,
      reason: "cleared",
    });
    expect(await exists(join(root, "service.json"))).toBe(false);
    expect(await exists(join(root, "service.lock"))).toBe(false);
  });

  it("reports nothing to clear when no state exists", async () => {
    expect(await removeStaleServiceMetadata(await workspace())).toMatchObject({
      removed: false,
      reason: "no-state",
    });
  });

  it("never clears state owned by a live process", async () => {
    const root = await workspace();
    const state = JSON.stringify({ pid: process.ppid, endpoint: "http://x" });
    await writeFile(join(root, "service.json"), state);
    await writeFile(join(root, "service.lock"), state);
    const result = await removeStaleServiceMetadata(root);
    expect(result).toMatchObject({ removed: false, reason: "owner-alive" });
    expect(await exists(join(root, "service.lock"))).toBe(true);
  });

  it("clears a lock left without metadata, which otherwise blocks every start", async () => {
    // The service throws ServiceAlreadyRunningError with no liveness check when
    // the lock exists but metadata does not, so this state must be recoverable.
    const root = await workspace();
    await writeFile(
      join(root, "service.lock"),
      JSON.stringify({ pid: 2 ** 22 }),
    );
    expect(await removeStaleServiceMetadata(root)).toMatchObject({
      removed: true,
    });
    expect(await exists(join(root, "service.lock"))).toBe(false);
  });

  it("reports command, log path, tail, and next action", () => {
    const error = new ServiceStartError({
      command: '/usr/bin/node "/opt/my product/index.mjs"',
      logPath: "/opt/home/logs/service.log",
      logTail: ["Error: listen EADDRINUSE"],
      reason: "service did not become healthy",
      nextAction: "Inspect the log, then retry with swf service start.",
      removedStaleMetadata: true,
    });
    expect(error.message).toContain("/opt/my product/index.mjs");
    expect(error.message).toContain("/opt/home/logs/service.log");
    expect(error.message).toContain("EADDRINUSE");
    expect(error.message).toContain("next:");
    expect(error.failure.removedStaleMetadata).toBe(true);
  });
});

describe("private log permissions", () => {
  it("creates the log directory with owner-only access", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await rotateServiceLog(logPath);
    const mode = (await stat(join(root, "logs"))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("writes rotated content without exposing it to other users", async () => {
    const root = await workspace();
    const logPath = join(root, "logs", "service.log");
    await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(logPath, "z".repeat(2048), { mode: 0o600 });
    await rotateServiceLog(logPath, { maximumBytes: 1024 });
    expect(((await stat(`${logPath}.1`)).mode & 0o077).toString(8)).toBe("0");
    expect(await readFile(`${logPath}.1`, "utf8")).toHaveLength(2048);
  });
});
