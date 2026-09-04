#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertPreviewArtifact,
  createGitFixture,
  createFastDevelopmentPlan,
  createInstance,
  ensureFastDashboardEndpoint,
  fixtureCapabilitySummary,
  fixtureEnvironment,
  inspectPreviewCommand,
  removeGitFixture,
  renderPreviewSummary,
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
import { buildProduct } from "./build-product.js";
import { verifyProduct } from "./verify-product.js";

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
    "  start [--instance <name>]                     Start an isolated source service",
    "  preview [--instance <name>]                   Build, stage, and run the artifact",
    "  fixture [--retain] [--change <name>]          Create a throwaway Git/OpenSpec repo",
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

async function ensureInstance(
  name: string,
  mode: DevelopmentInstance["mode"] = "fast",
): Promise<DevelopmentInstance> {
  try {
    return await readInstance(repositoryRoot, name);
  } catch {
    return createInstance({
      checkoutRoot: repositoryRoot,
      name,
      mode,
      sourceCommit: await sourceCommit(),
    });
  }
}

function describeInstance(instance: DevelopmentInstance): string {
  return [
    `instance   ${instance.name} (${instance.mode})`,
    `endpoint   ${instance.endpoint}`,
    ...(instance.dashboardEndpoint
      ? [`dashboard  ${instance.dashboardEndpoint}`]
      : []),
    `home       ${instance.serviceHome}`,
    `logs       ${instance.logsDirectory}`,
    `commit     ${instance.sourceCommit.slice(0, 12)}`,
    instance.pid ? `pid        ${instance.pid}` : "pid        (not running)",
  ].join("\n");
}

async function start(name: string): Promise<void> {
  const instance = await ensureFastDashboardEndpoint(
    await ensureInstance(name),
  );
  const existing = await instanceStatus(repositoryRoot, name);
  if (existing.health === "running") {
    process.stdout.write(
      `Instance ${name} is already running.\n${describeInstance(existing.instance)}\n`,
    );
    return;
  }
  const plan = createFastDevelopmentPlan(instance);
  const { instance: started, logPath } = await startInstance(
    repositoryRoot,
    name,
    {
      command: join(repositoryRoot, "node_modules", ".bin", "tsx"),
      args: [
        join(repositoryRoot, "scripts", "swf-fast-dev.ts"),
        "--instance",
        name,
      ],
      cwd: repositoryRoot,
    },
  );
  process.stdout.write(`${describeInstance(started)}\nlog        ${logPath}\n`);
  process.stdout.write(
    `\nPoint the checkout CLI at it with:\n  SWF_SERVICE_HOME=${started.serviceHome} NODE_OPTIONS=${plan.cli.environment.NODE_OPTIONS} pnpm swf <command>\n`,
  );
}

/**
 * Builds the release artifact, stages it inside the instance, installs only its
 * declared dependencies, and runs the compiled entries. Preview is the local
 * bridge to release verification, so it refuses anything that still resolves to
 * the source checkout.
 */
async function preview(name: string): Promise<void> {
  const instance = await ensureInstance(name, "preview");
  process.stdout.write("Assembling the product artifact...\n");
  const { staging, metadata } = await buildProduct({ channel: "development" });
  const verification = await verifyProduct(staging);
  if (verification.violations.length) {
    for (const violation of verification.violations)
      process.stderr.write(`  x ${violation}\n`);
    throw new Error("Refusing to preview an artifact that failed verification");
  }

  await rm(instance.packageDirectory, { recursive: true, force: true });
  await mkdir(instance.packageDirectory, { recursive: true, mode: 0o700 });
  await cp(staging, instance.packageDirectory, { recursive: true });

  process.stdout.write("Installing declared dependencies...\n");
  await runToCompletion(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"],
    instance.packageDirectory,
  );

  await assertPreviewArtifact(instance.packageDirectory, repositoryRoot);

  const serviceEntry = join(
    instance.packageDirectory,
    "service",
    "server",
    "index.mjs",
  );
  const executable = join(instance.packageDirectory, "bin", "swf.mjs");
  const commandViolations = inspectPreviewCommand(process.execPath, [
    serviceEntry,
  ]);
  if (commandViolations.length)
    throw new Error(commandViolations.map(({ detail }) => detail).join("\n"));

  const { instance: started, logPath } = await startInstance(
    repositoryRoot,
    name,
    {
      command: process.execPath,
      args: [serviceEntry],
      cwd: instance.packageDirectory,
    },
  );

  process.stdout.write(
    `${renderPreviewSummary({
      instance: started.name,
      mode: started.mode,
      productVersion: metadata.build.productVersion,
      channel: metadata.build.channel,
      sourceCommit: metadata.build.sourceCommit,
      sourceDirty: metadata.build.sourceDirty,
      publishable: metadata.build.publishable,
      endpoint: started.endpoint,
      executable,
      serviceEntry,
      serviceHome: started.serviceHome,
      logsDirectory: started.logsDirectory,
      fileCount: verification.entries.length,
      totalBytes: verification.totalBytes,
    })}\nlog         ${logPath}\n`,
  );
}

async function runToCompletion(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function fixture(): Promise<void> {
  const created = await createGitFixture({
    changeName: option("change", "fixture-change"),
    retain: flag("retain"),
    capabilities: {
      liveHarness: flag("live-harness"),
      hostedDelivery: flag("hosted-delivery"),
    },
  });
  process.stdout.write(
    [
      `root       ${created.root}`,
      `branch     ${created.branch}`,
      `commit     ${created.headCommit.slice(0, 12)}`,
      `change     ${created.changeName}`,
      ...fixtureCapabilitySummary(created).map((note) => `           ${note}`),
      ...Object.entries(fixtureEnvironment(created)).map(
        ([key, value]) => `${key}=${value}`,
      ),
    ].join("\n") + "\n",
  );
  if (created.retain)
    process.stdout.write("\nRetained. Remove it yourself when finished.\n");
  else {
    await removeGitFixture(created);
    process.stdout.write("\nRemoved. Pass --retain to keep it.\n");
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const name = option("instance", "default") ?? "default";

  switch (command) {
    case "start":
      await start(name);
      return;
    case "preview":
      await preview(name);
      return;
    case "fixture":
      await fixture();
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
