import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  instanceEnvironment,
  readInstance,
  writeInstance,
  type DevelopmentInstance,
} from "./instance.js";

export type InstanceHealth = "running" | "stopped" | "unreachable";

export interface InstanceStatus {
  instance: DevelopmentInstance;
  health: InstanceHealth;
  /** Present when the recorded process is gone but metadata still claims it. */
  staleProcess: boolean;
}

/** Signal 0 probes existence without delivering anything. */
export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function instanceStatus(
  checkoutRoot: string,
  name: string,
  probe: (endpoint: string) => Promise<boolean> = probeHealth,
): Promise<InstanceStatus> {
  const instance = await readInstance(checkoutRoot, name);
  const alive = processAlive(instance.pid);
  if (!alive)
    return {
      instance,
      health: "stopped",
      staleProcess: instance.pid !== undefined,
    };
  return {
    instance,
    health: (await probe(instance.endpoint)) ? "running" : "unreachable",
    staleProcess: false,
  };
}

async function probeHealth(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface StartOptions {
  command: string;
  args: string[];
  /** Defaults to the checkout so source-mode watchers resolve correctly. */
  cwd?: string;
  environment?: Record<string, string>;
}

export interface StartResult {
  instance: DevelopmentInstance;
  logPath: string;
}

/**
 * Starts a detached development service writing to the instance's own log.
 * The child inherits only the instance environment, so it cannot reach the
 * installed service home even if the parent shell exports SWF variables.
 */
export async function startInstance(
  checkoutRoot: string,
  name: string,
  options: StartOptions,
): Promise<StartResult> {
  const instance = await readInstance(checkoutRoot, name);
  const logPath = join(instance.logsDirectory, "service.log");
  const handle = await open(logPath, "a", 0o600);
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd ?? instance.checkoutRoot,
      env: {
        ...process.env,
        ...instanceEnvironment(instance),
        ...options.environment,
      },
      stdio: ["ignore", handle.fd, handle.fd],
      detached: true,
    });
    child.unref();
    const started: DevelopmentInstance = {
      ...instance,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
    await writeInstance(started);
    return { instance: started, logPath };
  } finally {
    await handle.close();
  }
}

export interface StopResult {
  stopped: boolean;
  reason: "signalled" | "already-stopped" | "stale-metadata";
}

/**
 * Stops a development service and clears its recorded process identity so a
 * later status never claims a healthy service that is gone.
 */
export async function stopInstance(
  checkoutRoot: string,
  name: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<StopResult> {
  const instance = await readInstance(checkoutRoot, name);
  if (instance.pid === undefined)
    return { stopped: false, reason: "already-stopped" };
  const alive = processAlive(instance.pid);
  // Clear the recorded identity first so a failed signal cannot leave metadata
  // claiming a healthy service.
  const cleared = { ...instance };
  delete cleared.pid;
  delete cleared.startedAt;
  await writeInstance(cleared);
  if (!alive) return { stopped: false, reason: "stale-metadata" };
  try {
    process.kill(instance.pid, signal);
  } catch {
    return { stopped: false, reason: "stale-metadata" };
  }
  return { stopped: true, reason: "signalled" };
}

export async function readInstanceLog(
  checkoutRoot: string,
  name: string,
  maxLines = 50,
): Promise<{ path: string; lines: string[] }> {
  const instance = await readInstance(checkoutRoot, name);
  const path = join(instance.logsDirectory, "service.log");
  try {
    await stat(path);
  } catch {
    return { path, lines: [] };
  }
  const contents = await readFile(path, "utf8");
  return {
    path,
    lines: contents.split("\n").filter(Boolean).slice(-maxLines),
  };
}

/**
 * Module replacement cannot preserve the scheduler, event broker, or service
 * ownership lock, so a change touching those must restart the isolated service
 * rather than hot-swap it. Serving two schedulers over one state directory
 * would duplicate work and corrupt ownership.
 */
const OWNERSHIP_CRITICAL_PATTERNS = [
  /swf-service\.ts$/,
  /harness-lifecycle\.ts$/,
  /event-store\.ts$/,
  /scheduler\.ts$/,
  /server\/plugins\//,
  /runtime\.ts$/,
];

export interface ReplacementDecision {
  safe: boolean;
  restartRequired: boolean;
  reason: string;
  changedPaths: string[];
}

export function evaluateModuleReplacement(
  changedPaths: string[],
): ReplacementDecision {
  const unsafe = changedPaths.filter((path) =>
    OWNERSHIP_CRITICAL_PATTERNS.some((pattern) => pattern.test(path)),
  );
  if (unsafe.length)
    return {
      safe: false,
      restartRequired: true,
      reason:
        "Changed modules own service state or process lifecycle; hot replacement would duplicate schedulers or lose ownership.",
      changedPaths: unsafe,
    };
  return {
    safe: true,
    restartRequired: false,
    reason: "Changed modules are stateless for service ownership.",
    changedPaths: [],
  };
}
