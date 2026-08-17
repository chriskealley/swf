#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createInstance,
  instanceEnvironment,
  instanceStatus,
  listInstances,
  readInstance,
  readInstanceLog,
  removeInstance,
  startInstance,
  stopInstance,
  type DevelopmentInstance,
} from "../packages/dev/src/index.js";
import { repositoryRoot } from "./product-layout.js";

/**
 * Checkout-local development CLI. Invoked as `pnpm dev <command>` from the
 * repository, it needs no global link and no shell function. Every instance is
 * isolated from the installed SWF service.
 */

function usage(): string {
  return [
    "Usage: pnpm dev <command> [options]",
    "",
    "Commands:",
    "  start [--instance <name>] [--project <path>]  Start an isolated service",
    "  list                                          List instances",
    "  status [--instance <name>]                    Show health and endpoint",
    "  logs [--instance <name>] [--lines <n>]        Print a bounded log tail",
    "  stop [--instance <name>]                      Stop the service",
    "  restart [--instance <name>]                   Stop then start",
    "  clean --instance <name> --yes                 Remove one instance",
    "",
    "Instances default to 'default' and live under .swf-dev/<instance>/.",
  ].join("\n");
}

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function sourceCommit(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolve("unknown"));
    child.once("close", () => resolve(out.trim() || "unknown"));
  });
}

async function ensureInstance(name: string): Promise<DevelopmentInstance> {
  try {
    return await readInstance(repositoryRoot, name);
  } catch {
    return createInstance({
      checkoutRoot: repositoryRoot,
      name,
      mode: "fast",
      sourceCommit: await sourceCommit(),
    });
  }
}

function describeInstance(instance: DevelopmentInstance): string {
  return [
    `instance   ${instance.name} (${instance.mode})`,
    `endpoint   ${instance.endpoint}`,
    `home       ${instance.serviceHome}`,
    `logs       ${instance.logsDirectory}`,
    `commit     ${instance.sourceCommit.slice(0, 12)}`,
    instance.pid ? `pid        ${instance.pid}` : "pid        (not running)",
  ].join("\n");
}

async function start(name: string): Promise<void> {
  const instance = await ensureInstance(name);
  const existing = await instanceStatus(repositoryRoot, name);
  if (existing.health === "running") {
    process.stdout.write(
      `Instance ${name} is already running.\n${describeInstance(existing.instance)}\n`,
    );
    return;
  }
  const { instance: started, logPath } = await startInstance(
    repositoryRoot,
    name,
    {
      command: "pnpm",
      args: [
        "--filter",
        "@swf/service",
        "dev",
        "--host=127.0.0.1",
        `--port=${instance.port}`,
      ],
      cwd: repositoryRoot,
    },
  );
  process.stdout.write(`${describeInstance(started)}\nlog        ${logPath}\n`);
  process.stdout.write(
    `\nPoint a checkout CLI at it with:\n  SWF_SERVICE_HOME=${started.serviceHome} pnpm swf <command>\n`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const name = option("instance", "default") ?? "default";

  switch (command) {
    case "start":
      await start(name);
      return;
    case "list": {
      const instances = await listInstances(repositoryRoot);
      if (!instances.length) {
        process.stdout.write("No development instances.\n");
        return;
      }
      for (const instance of instances) {
        const status = await instanceStatus(repositoryRoot, instance.name);
        process.stdout.write(
          `${instance.name.padEnd(16)} ${status.health.padEnd(12)} ${instance.endpoint}\n`,
        );
      }
      return;
    }
    case "status": {
      const status = await instanceStatus(repositoryRoot, name);
      process.stdout.write(
        `${describeInstance(status.instance)}\nhealth     ${status.health}${
          status.staleProcess ? " (stale process identity cleared on stop)" : ""
        }\n`,
      );
      return;
    }
    case "logs": {
      const lines = Number.parseInt(option("lines", "50") ?? "50", 10);
      const log = await readInstanceLog(repositoryRoot, name, lines);
      process.stdout.write(`${log.path}\n`);
      process.stdout.write(
        log.lines.length ? `${log.lines.join("\n")}\n` : "(empty)\n",
      );
      return;
    }
    case "stop": {
      const result = await stopInstance(repositoryRoot, name);
      process.stdout.write(`${name}: ${result.reason}\n`);
      return;
    }
    case "restart": {
      await stopInstance(repositoryRoot, name);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await start(name);
      return;
    }
    case "clean": {
      if (!flag("yes")) {
        const paths = await readInstance(repositoryRoot, name);
        process.stderr.write(
          `Refusing to remove ${name} without --yes.\nWould remove: ${join(
            paths.checkoutRoot,
            ".swf-dev",
            name,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      await stopInstance(repositoryRoot, name).catch(() => undefined);
      const removed = await removeInstance(repositoryRoot, name);
      process.stdout.write(`Removed ${removed}\n`);
      return;
    }
    case "env": {
      const instance = await readInstance(repositoryRoot, name);
      for (const [key, value] of Object.entries(instanceEnvironment(instance)))
        process.stdout.write(`${key}=${value}\n`);
      return;
    }
    default:
      process.stdout.write(`${usage()}\n`);
      if (command) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
