#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFastDevelopmentPlan,
  evaluateModuleReplacement,
  processAlive,
  readInstance,
  type FastDevelopmentProcess,
} from "../packages/dev/src/index.js";
import {
  readLocalServiceMetadata,
  removeStaleServiceMetadata,
  SwfServiceClient,
} from "../packages/core/src/index.js";
import { repositoryRoot } from "./product-layout.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function writeOutput(label: string, chunk: Buffer): void {
  for (const line of chunk.toString().split("\n"))
    if (line) process.stdout.write(`[${label}] ${line}\n`);
}

function launch(
  label: string,
  processPlan: FastDevelopmentProcess,
): ChildProcess {
  const child = spawn(processPlan.command, processPlan.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...processPlan.environment },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk: Buffer) => writeOutput(label, chunk));
  child.stderr?.on("data", (chunk: Buffer) => writeOutput(label, chunk));
  return child;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolveStopped) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        // It exited between the timeout and signal.
      }
    }, 5_000);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolveStopped();
    });
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid!, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolveStopped();
    }
  });
}

async function retireServiceOwner(serviceHome: string): Promise<void> {
  const metadata = await readLocalServiceMetadata(serviceHome).catch(
    () => undefined,
  );
  if (!metadata) return;

  try {
    await new SwfServiceClient(metadata).shutdown();
  } catch (error) {
    process.stderr.write(
      `[supervisor] graceful service drain failed; signalling the isolated writer: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    try {
      process.kill(metadata.pid, "SIGTERM");
    } catch {
      // It exited after metadata was read.
    }
  }

  const deadline = Date.now() + 10_000;
  while (processAlive(metadata.pid) && Date.now() < deadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (processAlive(metadata.pid))
    throw new Error(
      `Service writer ${metadata.pid} did not stop; refusing to start a duplicate scheduler`,
    );
  const stale = await removeStaleServiceMetadata(serviceHome);
  if (stale.reason === "owner-alive")
    throw new Error(
      `Service writer ${stale.ownerPid} still owns the state; refusing to start a duplicate scheduler`,
    );
}

async function main(): Promise<void> {
  const name = option("instance");
  if (!name) throw new Error("--instance is required");
  const instance = await readInstance(repositoryRoot, name);
  if (instance.mode !== "fast")
    throw new Error(`Instance ${name} is ${instance.mode}, not fast mode`);
  const plan = createFastDevelopmentPlan(instance);

  let shuttingDown = false;
  let restartQueue = Promise.resolve();
  let restartTimer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  const intentionalStops = new WeakSet<ChildProcess>();
  let service: ChildProcess;

  const launchService = (): ChildProcess => {
    const child = launch("service", plan.service);
    child.once("error", async (error) => {
      process.stderr.write(`[service] ${error.message}\n`);
      await shutdown(1);
    });
    child.once("close", async (code) => {
      if (!shuttingDown && !intentionalStops.has(child))
        await shutdown(code ?? 1);
    });
    return child;
  };

  service = launchService();
  const dashboard = launch("dashboard", plan.dashboard);

  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    intentionalStops.add(service);
    await Promise.all([stopChild(service), stopChild(dashboard)]);
    await retireServiceOwner(instance.serviceHome);
    process.exitCode = code;
  };

  const scheduleControlledRestart = (changedPath: string): void => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartQueue = restartQueue
        .then(async () => {
          if (shuttingDown) return;
          process.stdout.write(
            `[supervisor] ownership-critical change: ${changedPath}\n` +
              "[supervisor] stopping the service before restarting it\n",
          );
          intentionalStops.add(service);
          await stopChild(service);
          await retireServiceOwner(instance.serviceHome);
          if (!shuttingDown) service = launchService();
        })
        .catch(async (error) => {
          process.stderr.write(
            `[supervisor] controlled restart failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          await shutdown(1);
        });
    }, 150);
  };

  for (const root of plan.watchRoots) {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || shuttingDown) return;
      const changedPath = relative(
        repositoryRoot,
        resolve(root, filename.toString()),
      ).replaceAll("\\", "/");
      if (evaluateModuleReplacement([changedPath]).restartRequired)
        scheduleControlledRestart(changedPath);
    });
    watchers.push(watcher);
  }

  dashboard.once("error", async (error) => {
    process.stderr.write(`[dashboard] ${error.message}\n`);
    await shutdown(1);
  });
  dashboard.once("close", async (code) => {
    if (!shuttingDown) await shutdown(code ?? 1);
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
