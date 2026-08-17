import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redactor } from "./security.js";
import { PRODUCT_COMPATIBILITY, evaluateCompatibility } from "./product.js";
import type { ProductMetadata } from "./product.js";

/** Relative to the installed product root; mirrors the assembled layout. */
export const PACKAGED_SERVICE_ENTRY = join("service", "server", "index.mjs");

const ENTRY_SEARCH_DEPTH = 6;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the packaged service entry relative to the calling module. Bundlers
 * place the CLI at different depths, so the search walks upward rather than
 * assuming one fixed relative path.
 */
export async function resolvePackagedServiceEntry(
  fromDirectory = dirname(fileURLToPath(import.meta.url)),
): Promise<string | undefined> {
  let directory = fromDirectory;
  for (let depth = 0; depth < ENTRY_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, PACKAGED_SERVICE_ENTRY);
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * The path the packaged entry would occupy, whether or not it currently exists.
 * Diagnostics need this: a definition referencing a moved or deleted product
 * must still be describable, and `resolvePackagedServiceEntry` returns nothing
 * once the file is gone.
 */
export async function expectedPackagedServiceEntry(
  fromDirectory = dirname(fileURLToPath(import.meta.url)),
): Promise<string | undefined> {
  const resolved = await resolvePackagedServiceEntry(fromDirectory);
  if (resolved) return resolved;
  let directory = fromDirectory;
  for (let depth = 0; depth < ENTRY_SEARCH_DEPTH; depth += 1) {
    // The product root is the directory holding the packaged manifest.
    if (await exists(join(directory, "package.json")))
      return join(directory, PACKAGED_SERVICE_ENTRY);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export interface ServiceLaunchPlan {
  /** Always the current Node binary; never a shell or package manager. */
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  logPath: string;
  serviceHome: string;
  endpoint: string;
}

export interface LaunchPlanInput {
  serviceEntry: string;
  serviceHome: string;
  port: number;
  cwd?: string;
  host?: string;
  environment?: Record<string, string>;
  nodeExecutable?: string;
}

/**
 * Builds an argument-array launch plan. Arguments are never joined into a
 * command string, so a product installed under a path containing spaces starts
 * correctly. The host is pinned to loopback because the Nitro node-server
 * preset otherwise binds every interface.
 */
export function createServiceLaunchPlan(
  input: LaunchPlanInput,
): ServiceLaunchPlan {
  const host = input.host ?? "127.0.0.1";
  return {
    executable: input.nodeExecutable ?? process.execPath,
    args: [input.serviceEntry],
    cwd: input.cwd ?? input.serviceHome,
    serviceHome: input.serviceHome,
    endpoint: `http://${host}:${input.port}`,
    logPath: join(input.serviceHome, "logs", "service.log"),
    environment: {
      SWF_SERVICE_HOME: input.serviceHome,
      SWF_CONFIG_HOME: input.serviceHome,
      HOST: host,
      NITRO_HOST: host,
      PORT: String(input.port),
      NITRO_PORT: String(input.port),
      ...input.environment,
    },
  };
}

export interface LogRotationOptions {
  maximumBytes?: number;
  retainedFiles?: number;
}

/**
 * Rotates the service log before a launch so a long-lived installation cannot
 * grow an unbounded file. Rotation happens at start rather than during writes,
 * keeping the running service's file descriptor stable.
 */
export async function rotateServiceLog(
  logPath: string,
  options: LogRotationOptions = {},
): Promise<boolean> {
  const maximumBytes = options.maximumBytes ?? 5 * 1024 * 1024;
  const retained = options.retainedFiles ?? 3;
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const current = await stat(logPath).catch(() => undefined);
  if (!current || current.size < maximumBytes) return false;

  for (let index = retained - 1; index >= 1; index -= 1) {
    const from = `${logPath}.${index}`;
    if (await exists(from)) await rename(from, `${logPath}.${index + 1}`);
  }
  await rename(logPath, `${logPath}.1`);
  await rm(`${logPath}.${retained + 1}`, { force: true });
  return true;
}

export interface ServiceLogTail {
  path: string;
  lines: string[];
  truncated: boolean;
}

/**
 * Reads a bounded, redacted tail. Service logs can contain credentials echoed
 * by a failing dependency, so redaction applies before the text is shown.
 */
export async function readServiceLogTail(
  logPath: string,
  maximumLines = 40,
  redactor = new Redactor(),
): Promise<ServiceLogTail> {
  const { readFile } = await import("node:fs/promises");
  const contents = await readFile(logPath, "utf8").catch(() => "");
  const all = contents.split("\n").filter(Boolean);
  return {
    path: logPath,
    lines: all.slice(-maximumLines).map((line) => redactor.text(line)),
    truncated: all.length > maximumLines,
  };
}

export interface ServiceHealth {
  status?: string;
  /** False when the process is listening but SWF did not claim its state. */
  ready?: boolean;
  reason?: string;
  product?: ProductMetadata["build"];
  compatibility?: ProductMetadata["compatibility"];
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  health?: ServiceHealth;
  compatibility?: ReturnType<typeof evaluateCompatibility>;
}

export interface ReadinessOptions {
  attempts?: number;
  intervalMs?: number;
  fetchImplementation?: typeof fetch;
  clientVersion?: string;
  clientApiProtocolVersion?: number;
}

/**
 * Waits for the service to publish health and then verifies the compatibility
 * handshake. Reporting a successful start before this completes would let a
 * client mutate state through a service it cannot safely talk to.
 */
export async function waitForServiceReadiness(
  endpoint: string,
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 250;
  const request = options.fetchImplementation ?? fetch;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request(`${endpoint}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    if (response?.ok) {
      const health = (await response.json().catch(() => ({}))) as ServiceHealth;
      // A listening process is not a ready service: the HTTP route answers
      // before SWF has claimed its state directory.
      if (health.ready === false) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      if (!health.compatibility)
        return {
          ready: true,
          health,
          reason: "service reported no compatibility metadata",
        };
      const compatibility = evaluateCompatibility(health.compatibility, {
        clientVersion: options.clientVersion,
        clientApiProtocolVersion:
          options.clientApiProtocolVersion ??
          PRODUCT_COMPATIBILITY.apiProtocolVersion,
      });
      return {
        ready: compatibility.compatible,
        health,
        compatibility,
        reason: compatibility.compatible
          ? undefined
          : compatibility.findings
              .filter(({ status }) => status === "incompatible")
              .map(({ detail, remediation }) =>
                remediation ? `${detail}. ${remediation}` : detail,
              )
              .join("; "),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const final = await request(`${endpoint}/api/health`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  const body = final?.ok
    ? ((await final.json().catch(() => ({}))) as ServiceHealth)
    : undefined;
  return {
    ready: false,
    health: body,
    reason:
      body?.reason ??
      (body?.ready === false
        ? "service is listening but did not claim its state directory"
        : "service did not become healthy"),
  };
}

export interface StartFailure {
  command: string;
  logPath: string;
  logTail: string[];
  reason: string;
  nextAction: string;
  removedStaleMetadata: boolean;
}

export class ServiceStartError extends Error {
  constructor(readonly failure: StartFailure) {
    super(
      [
        `SWF service failed to start: ${failure.reason}`,
        `command: ${failure.command}`,
        `log: ${failure.logPath}`,
        ...failure.logTail.map((line) => `  ${line}`),
        `next: ${failure.nextAction}`,
      ].join("\n"),
    );
    this.name = "ServiceStartError";
  }
}

export interface StaleStateResult {
  removed: boolean;
  reason: "no-state" | "owner-alive" | "cleared";
  ownerPid?: number;
}

function ownerIsAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Clears service state left by a failed or crashed start.
 *
 * The ownership lock and the metadata file must be removed together. The
 * service refuses to start when the lock exists but metadata does not, and it
 * performs no liveness check in that case, so removing only one leaves an
 * installation permanently unstartable. Nothing is removed while the recorded
 * owner is still alive, because that lock is doing its job.
 */
export async function removeStaleServiceMetadata(
  serviceHome: string,
): Promise<StaleStateResult> {
  const metadataPath = join(serviceHome, "service.json");
  const lockPath = join(serviceHome, "service.lock");
  const [hasMetadata, hasLock] = await Promise.all([
    exists(metadataPath),
    exists(lockPath),
  ]);
  if (!hasMetadata && !hasLock) return { removed: false, reason: "no-state" };

  const { readFile } = await import("node:fs/promises");
  const recorded = await (async () => {
    for (const path of [metadataPath, lockPath]) {
      const raw = await readFile(path, "utf8").catch(() => "");
      if (!raw.trim()) continue;
      try {
        return JSON.parse(raw) as { pid?: number };
      } catch {
        continue;
      }
    }
    return undefined;
  })();

  if (ownerIsAlive(recorded?.pid))
    return {
      removed: false,
      reason: "owner-alive",
      ownerPid: recorded?.pid,
    };

  await rm(metadataPath, { force: true });
  await rm(lockPath, { force: true });
  return { removed: true, reason: "cleared", ownerPid: recorded?.pid };
}

export function describeLaunchCommand(plan: ServiceLaunchPlan): string {
  return [plan.executable, ...plan.args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export interface StartedService {
  pid?: number;
  plan: ServiceLaunchPlan;
  health?: ServiceHealth;
  logPath: string;
}

/**
 * Spawns the packaged service detached, with private logs, and reports success
 * only after readiness and compatibility are confirmed. On failure it clears
 * metadata and surfaces the command, a bounded redacted log tail, and the next
 * diagnostic step.
 */
export async function startPackagedService(
  plan: ServiceLaunchPlan,
  options: ReadinessOptions & LogRotationOptions = {},
): Promise<StartedService> {
  await mkdir(plan.serviceHome, { recursive: true, mode: 0o700 });
  // Recover from a lock left by a crashed or force-stopped service before
  // launching; a live owner is always left alone.
  await removeStaleServiceMetadata(plan.serviceHome);
  await rotateServiceLog(plan.logPath, options);
  const handle = await open(plan.logPath, "a", 0o600);
  let child;
  try {
    child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: { PATH: process.env.PATH ?? "", ...plan.environment },
      stdio: ["ignore", handle.fd, handle.fd],
      detached: true,
    });
    child.unref();
  } finally {
    await handle.close();
  }

  const readiness = await waitForServiceReadiness(plan.endpoint, options);
  if (!readiness.ready) {
    const tail = await readServiceLogTail(plan.logPath);
    const stale = await removeStaleServiceMetadata(plan.serviceHome);
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      // The process already exited; nothing to terminate.
    }
    throw new ServiceStartError({
      command: describeLaunchCommand(plan),
      logPath: plan.logPath,
      logTail: tail.lines,
      reason: readiness.reason ?? "unknown failure",
      nextAction:
        readiness.compatibility !== undefined
          ? "Upgrade the CLI or restart the service so both report one API protocol."
          : stale.reason === "owner-alive"
            ? `Another SWF service (pid ${stale.ownerPid}) owns ${plan.serviceHome}. Stop it with swf service stop.`
            : `Inspect ${plan.logPath}, then retry with swf service start.`,
      removedStaleMetadata: stale.removed,
    });
  }

  return {
    pid: child.pid,
    plan,
    health: readiness.health,
    logPath: plan.logPath,
  };
}

/** Lists rotated log files so an operator can find retained history. */
export async function listServiceLogs(serviceHome: string): Promise<string[]> {
  const directory = join(serviceHome, "logs");
  const entries = await readdir(directory).catch((): string[] => []);
  return entries
    .filter((entry) => entry.startsWith("service.log"))
    .sort()
    .map((entry) => join(directory, entry));
}
