import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_DIRECTORY,
  INSTALLED_SERVICE_PORT,
  InstanceExistsError,
  InstanceNotFoundError,
  allocateLoopbackPort,
  createInstance,
  developmentRoot,
  evaluateModuleReplacement,
  instanceEnvironment,
  instancePaths,
  instanceStatus,
  listInstances,
  processAlive,
  readInstance,
  readInstanceLog,
  removeInstance,
  startInstance,
  stopInstance,
} from "../src/index.js";

const temporary: string[] = [];

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swf-checkout-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("development instance metadata", () => {
  it("creates isolated directories under the checkout", async () => {
    const root = await checkout();
    const instance = await createInstance({
      checkoutRoot: root,
      name: "alpha",
      mode: "fast",
      sourceCommit: "a".repeat(40),
    });
    const paths = instancePaths(root, "alpha");
    expect(instance.endpoint).toBe(`http://127.0.0.1:${instance.port}`);
    for (const directory of [
      paths.serviceHome,
      paths.logsDirectory,
      paths.packageDirectory,
    ])
      expect((await stat(directory)).isDirectory()).toBe(true);
    expect(instance.serviceHome.startsWith(developmentRoot(root))).toBe(true);
  });

  it("records mode, checkout, commit, endpoint, and paths", async () => {
    const root = await checkout();
    const instance = await createInstance({
      checkoutRoot: root,
      name: "beta",
      mode: "preview",
      sourceCommit: "b".repeat(40),
    });
    expect(instance).toMatchObject({
      schemaVersion: 1,
      name: "beta",
      mode: "preview",
      checkoutRoot: root,
      sourceCommit: "b".repeat(40),
    });
    expect(await readInstance(root, "beta")).toEqual(instance);
  });

  it("writes metadata with private permissions", async () => {
    const root = await checkout();
    await createInstance({
      checkoutRoot: root,
      name: "gamma",
      mode: "fast",
      sourceCommit: "c".repeat(40),
    });
    const mode = (await stat(instancePaths(root, "gamma").metadataPath)).mode;
    expect((mode & 0o777).toString(8)).toBe("600");
  });

  it("rejects a duplicate instance name", async () => {
    const root = await checkout();
    const input = {
      checkoutRoot: root,
      name: "dup",
      mode: "fast" as const,
      sourceCommit: "d".repeat(40),
    };
    await createInstance(input);
    await expect(createInstance(input)).rejects.toBeInstanceOf(
      InstanceExistsError,
    );
  });

  it("rejects a non-kebab-case name", async () => {
    await expect(
      createInstance({
        checkoutRoot: await checkout(),
        name: "Not Valid",
        mode: "fast",
        sourceCommit: "e".repeat(40),
      }),
    ).rejects.toThrow();
  });

  it("reports a missing instance clearly", async () => {
    await expect(
      readInstance(await checkout(), "absent"),
    ).rejects.toBeInstanceOf(InstanceNotFoundError);
  });
});

describe("endpoint isolation", () => {
  it("allocates a free loopback port that is never the installed service port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(INSTALLED_SERVICE_PORT);
  });

  it("refuses an explicit installed service port", async () => {
    await expect(
      createInstance({
        checkoutRoot: await checkout(),
        name: "clash",
        mode: "fast",
        sourceCommit: "f".repeat(40),
        port: INSTALLED_SERVICE_PORT,
      }),
    ).rejects.toThrow(String(INSTALLED_SERVICE_PORT));
  });

  it("gives concurrent instances distinct ports, homes, and logs", async () => {
    const root = await checkout();
    const first = await createInstance({
      checkoutRoot: root,
      name: "one",
      mode: "fast",
      sourceCommit: "1".repeat(40),
    });
    const second = await createInstance({
      checkoutRoot: root,
      name: "two",
      mode: "fast",
      sourceCommit: "1".repeat(40),
    });
    expect(first.port).not.toBe(second.port);
    expect(first.serviceHome).not.toBe(second.serviceHome);
    expect(first.logsDirectory).not.toBe(second.logsDirectory);
    expect((await listInstances(root)).map(({ name }) => name)).toEqual([
      "one",
      "two",
    ]);
  });

  it("pins the child environment to its own home and loopback host", async () => {
    const root = await checkout();
    const instance = await createInstance({
      checkoutRoot: root,
      name: "env",
      mode: "fast",
      sourceCommit: "2".repeat(40),
    });
    const environment = instanceEnvironment(instance);
    expect(environment.SWF_SERVICE_HOME).toBe(instance.serviceHome);
    expect(environment.SWF_CONFIG_HOME).toBe(instance.serviceHome);
    expect(environment.HOST).toBe("127.0.0.1");
    expect(environment.PORT).toBe(String(instance.port));
  });
});

describe("installed state is untouched", () => {
  it("never reads or writes outside the checkout", async () => {
    const root = await checkout();
    const fakeUserHome = await mkdtemp(join(tmpdir(), "swf-user-home-"));
    temporary.push(fakeUserHome);
    const installedMetadata = join(fakeUserHome, "service.json");
    const original = JSON.stringify({ serviceId: "installed", pid: 1 });
    await writeFile(installedMetadata, original);

    await createInstance({
      checkoutRoot: root,
      name: "isolated",
      mode: "fast",
      sourceCommit: "3".repeat(40),
    });

    expect(await readFile(installedMetadata, "utf8")).toBe(original);
    expect(await readdir(fakeUserHome)).toEqual(["service.json"]);
  });

  it("confines every instance path below the checkout dev root", async () => {
    const root = await checkout();
    const instance = await createInstance({
      checkoutRoot: root,
      name: "confined",
      mode: "fast",
      sourceCommit: "4".repeat(40),
    });
    const devRoot = join(root, DEVELOPMENT_DIRECTORY);
    for (const path of [
      instance.serviceHome,
      instance.logsDirectory,
      instance.packageDirectory,
    ])
      expect(path.startsWith(devRoot)).toBe(true);
  });

  it("cleans only the selected instance", async () => {
    const root = await checkout();
    await createInstance({
      checkoutRoot: root,
      name: "keep",
      mode: "fast",
      sourceCommit: "5".repeat(40),
    });
    await createInstance({
      checkoutRoot: root,
      name: "drop",
      mode: "fast",
      sourceCommit: "5".repeat(40),
    });
    await removeInstance(root, "drop");
    expect((await listInstances(root)).map(({ name }) => name)).toEqual([
      "keep",
    ]);
    await expect(removeInstance(root, "drop")).rejects.toBeInstanceOf(
      InstanceNotFoundError,
    );
  });
});

describe("instance lifecycle", () => {
  it("starts a detached process, records it, and captures its log", async () => {
    const root = await checkout();
    await createInstance({
      checkoutRoot: root,
      name: "run",
      mode: "fast",
      sourceCommit: "6".repeat(40),
    });
    const { instance, logPath } = await startInstance(root, "run", {
      command: process.execPath,
      args: ["-e", "console.log('service up'); setTimeout(() => {}, 30000)"],
    });
    expect(instance.pid).toBeGreaterThan(0);
    expect(instance.startedAt).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await readInstanceLog(root, "run");
    expect(log.path).toBe(logPath);
    expect(log.lines.join("\n")).toContain("service up");
    expect(await stopInstance(root, "run")).toMatchObject({ stopped: true });
    expect((await readInstance(root, "run")).pid).toBeUndefined();
  });

  it("reports stopped rather than running for a stale process identity", async () => {
    const root = await checkout();
    const created = await createInstance({
      checkoutRoot: root,
      name: "stale",
      mode: "fast",
      sourceCommit: "7".repeat(40),
    });
    const { writeInstance } = await import("../src/instance.js");
    await writeInstance({
      ...created,
      pid: 2 ** 22,
      startedAt: created.createdAt,
    });
    const status = await instanceStatus(root, "stale", async () => true);
    expect(status.health).toBe("stopped");
    expect(status.staleProcess).toBe(true);
  });

  it("distinguishes an unreachable service from a stopped one", async () => {
    const root = await checkout();
    const created = await createInstance({
      checkoutRoot: root,
      name: "unreachable",
      mode: "fast",
      sourceCommit: "8".repeat(40),
    });
    const { writeInstance } = await import("../src/instance.js");
    await writeInstance({
      ...created,
      pid: process.pid,
      startedAt: created.createdAt,
    });
    const status = await instanceStatus(root, "unreachable", async () => false);
    expect(status.health).toBe("unreachable");
    expect(status.staleProcess).toBe(false);
  });

  it("treats a missing process identity as already stopped", async () => {
    const root = await checkout();
    await createInstance({
      checkoutRoot: root,
      name: "idle",
      mode: "fast",
      sourceCommit: "9".repeat(40),
    });
    expect(await stopInstance(root, "idle")).toMatchObject({
      stopped: false,
      reason: "already-stopped",
    });
  });

  it("detects a live process and an absent one", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(undefined)).toBe(false);
    expect(processAlive(2 ** 22)).toBe(false);
  });

  it("returns an empty log for an instance that never started", async () => {
    const root = await checkout();
    await createInstance({
      checkoutRoot: root,
      name: "nolog",
      mode: "fast",
      sourceCommit: "a".repeat(40),
    });
    expect((await readInstanceLog(root, "nolog")).lines).toEqual([]);
  });

  it("lists nothing when no instances exist", async () => {
    expect(await listInstances(await checkout())).toEqual([]);
  });
});

describe("hot replacement safety", () => {
  it("requires a restart when service-owning modules change", () => {
    const decision = evaluateModuleReplacement([
      "apps/service/src/server/swf-service.ts",
      "apps/dashboard/src/App.vue",
    ]);
    expect(decision.restartRequired).toBe(true);
    expect(decision.safe).toBe(false);
    expect(decision.changedPaths).toContain(
      "apps/service/src/server/swf-service.ts",
    );
  });

  it("requires a restart for lifecycle and event-store changes", () => {
    for (const path of [
      "packages/core/src/harness-lifecycle.ts",
      "packages/core/src/event-store.ts",
      "packages/core/src/scheduler.ts",
      "apps/service/src/server/plugins/swf.ts",
    ])
      expect(evaluateModuleReplacement([path]).restartRequired).toBe(true);
  });

  it("allows replacement for presentation-only changes", () => {
    const decision = evaluateModuleReplacement([
      "apps/dashboard/src/App.vue",
      "apps/cli/src/operator-renderer.ts",
    ]);
    expect(decision.safe).toBe(true);
    expect(decision.restartRequired).toBe(false);
    expect(decision.changedPaths).toEqual([]);
  });
});
