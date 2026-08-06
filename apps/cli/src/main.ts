#!/usr/bin/env node
import { spawn } from "node:child_process";
import { defineCommand, runMain } from "citty";
import consola from "consola";
import { detectPackageManager } from "nypm";
import {
  ServiceUnavailableError,
  SwfServiceClient,
  applySetupPlan,
  createSetupPlan,
  initializeProject,
  readLocalServiceMetadata,
  runDoctor,
  type CheckStatus,
  type SetupAction,
} from "@swf/core";

const SCHEMA_VERSION = 1;
function output(value: unknown, json = false): void {
  if (json)
    console.log(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, result: value }, null, 2),
    );
  else
    consola.log(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
}
function fail(error: unknown, json = false): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (json)
    console.log(
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          error: { code: "SWF_ERROR", message },
        },
        null,
        2,
      ),
    );
  else consola.error(message);
  process.exitCode = error instanceof ServiceUnavailableError ? 3 : 1;
}
async function client(): Promise<SwfServiceClient> {
  return SwfServiceClient.connect();
}
function icon(status: CheckStatus): string {
  return { pass: "✓", fail: "✗", warn: "!", skip: "-" }[status];
}

const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Check SWF prerequisites without making changes",
  },
  args: { json: { type: "boolean" }, harness: { type: "string" } },
  async run({ args }) {
    const checks = await runDoctor({
      selectedHarnesses: args.harness ? ([args.harness] as never[]) : [],
    });
    if (args.json) return output({ checks }, true);
    for (const check of checks) {
      consola.log(`${icon(check.status)} ${check.id}: ${check.summary}`);
      if (check.remediation) consola.info(`  ${check.remediation}`);
    }
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
  },
});

const setup = defineCommand({
  meta: {
    name: "setup",
    description:
      "Preview or explicitly apply supported prerequisite remediation",
  },
  args: {
    install: { type: "positional", required: true },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const plan = createSetupPlan([args.install]);
    const packageManager = await detectPackageManager(process.cwd());
    if (!args.apply) {
      output({ packageManager: packageManager?.name, plan }, args.json);
      return;
    }
    if (!args.yes)
      throw new Error(
        "Refusing setup without --yes. Review the plan first by omitting --apply.",
      );
    const result = await applySetupPlan(plan, {
      confirm: async (_action: SetupAction) => true,
      execute: async (command, commandArgs) =>
        new Promise((resolve) => {
          const child = spawn(command, commandArgs, {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data: Buffer) => (stdout += data));
          child.stderr.on("data", (data: Buffer) => (stderr += data));
          child.on("close", (code) =>
            resolve({ code: code ?? 1, stdout, stderr }),
          );
        }),
    });
    const verification = await runDoctor();
    output({ result, verification }, args.json);
    if (
      result.results.some((item) => !item.applied) ||
      result.unsupported.length ||
      verification.some((check) => check.status === "fail")
    )
      process.exitCode = 1;
  },
});

const init = defineCommand({
  meta: {
    name: "init",
    description: "Initialize committed SWF project configuration",
  },
  args: {
    cwd: { type: "string" },
    trust: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const result = await initializeProject({
      cwd: args.cwd,
      trust: args.trust,
    });
    output(result, args.json);
    if (result.status === "untrusted") process.exitCode = 1;
  },
});

const serviceStatus = defineCommand({
  meta: { name: "status", description: "Show local service status" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    try {
      output(await readLocalServiceMetadata(), args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const serviceStart = defineCommand({
  meta: {
    name: "start",
    description: "Start the persistent local SWF service",
  },
  args: {
    json: { type: "boolean" },
    command: {
      type: "string",
      description: "Service command (defaults to pnpm service dev)",
    },
  },
  async run({ args }) {
    try {
      output(await readLocalServiceMetadata(), args.json);
      return;
    } catch (error) {
      if (!(error instanceof ServiceUnavailableError)) throw error;
    }
    const [command, ...commandArgs] = (
      args.command ?? "pnpm --filter @swf/service dev"
    ).split(" ");
    const child = spawn(command!, commandArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    let metadata;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        metadata = await readLocalServiceMetadata();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!metadata)
      throw new ServiceUnavailableError(
        "SWF service did not publish metadata within 5 seconds",
      );
    output({ started: true, pid: child.pid, metadata }, args.json);
  },
});
const serviceStop = defineCommand({
  meta: { name: "stop", description: "Stop the persistent local SWF service" },
  args: { force: { type: "boolean" }, json: { type: "boolean" } },
  async run({ args }) {
    try {
      await (await client()).shutdown(args.force);
      output({ stopped: true, force: Boolean(args.force) }, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const serviceDiagnostic = defineCommand({
  meta: {
    name: "diagnostic",
    description: "Report service metadata and connectivity",
  },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    try {
      const active = await client();
      const projects = await active.query("projects");
      output({ metadata: active.metadata, projects }, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const service = defineCommand({
  meta: {
    name: "service",
    description: "Start, inspect, or stop the local SWF service",
  },
  subCommands: {
    start: serviceStart,
    status: serviceStatus,
    stop: serviceStop,
    diagnostic: serviceDiagnostic,
  },
});

function queryCommand(name: string, resource: string, needsRun = true) {
  return defineCommand({
    meta: { name, description: `Query SWF ${resource}` },
    args: {
      project: {
        type: "string",
        required: resource !== "blocked-inputs" && resource !== "projects",
      },
      run: { type: "string", required: needsRun },
      json: { type: "boolean" },
    },
    async run({
      args,
    }: {
      args: { project?: string; run?: string; json?: boolean };
    }) {
      try {
        output(
          await (
            await client()
          ).query(resource, { projectId: args.project, runId: args.run }),
          args.json,
        );
      } catch (error) {
        fail(error, args.json);
      }
    },
  });
}
function lifecycleCommand(
  name: string,
  type: string,
  extras: Record<string, unknown> = {},
) {
  return defineCommand({
    meta: { name, description: `${name} a SWF run` },
    args: {
      project: { type: "string", required: true },
      run: { type: "string", required: true },
      phase: { type: "string" },
      gate: { type: "string" },
      checkpoint: { type: "string" },
      reason: { type: "string" },
      actor: { type: "string" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      const input = args as unknown as {
        project: string;
        run: string;
        phase?: string;
        gate?: string;
        checkpoint?: string;
        reason?: string;
        actor?: string;
        json?: boolean;
      };
      try {
        await (
          await client()
        ).command({
          type,
          projectId: input.project,
          runId: input.run,
          phaseId: input.phase,
          gateId: input.gate,
          checkpointId: input.checkpoint,
          reason: input.reason,
          actorId: input.actor ?? "operator",
          ...extras,
        });
        output({ accepted: true, type }, input.json);
      } catch (error) {
        fail(error, input.json);
      }
    },
  });
}

const status = queryCommand("status", "run");
const events = queryCommand("events", "run");
const artifacts = queryCommand("artifacts", "artifacts");
const logs = queryCommand("log", "invocations");
const costs = queryCommand("cost", "costs");
const configuration = queryCommand("config", "configuration", false);
const pause = lifecycleCommand("pause", "pause");
const resume = lifecycleCommand("resume", "resume");
const cancel = lifecycleCommand("cancel", "cancel");
const approve = lifecycleCommand("approve", "approve");
const reject = lifecycleCommand("reject", "reject");
const rollback = lifecycleCommand("rollback", "rollback");
const blockedInput = defineCommand({
  meta: {
    name: "input",
    description: "Reply to an agent blocked on operator input",
  },
  args: {
    invocation: { type: "string", required: true },
    response: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      await (
        await client()
      ).command({
        type: "blocked-input",
        invocationId: args.invocation,
        response: args.response,
      });
      output({ accepted: true }, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});

// These thin commands deliberately delegate lifecycle decisions to the service.
const newRun = lifecycleCommand("new", "start");
const automaticRun = lifecycleCommand("run", "start");
const next = lifecycleCommand("next", "start");
const phase = defineCommand({
  meta: { name: "phase", description: "Inspect or control a named phase" },
  subCommands: {
    list: queryCommand("list", "phases"),
    status: queryCommand("status", "phases"),
    explain: queryCommand("explain", "phases"),
    run: lifecycleCommand("run", "start"),
    rerun: lifecycleCommand("rerun", "remediate"),
    skip: lifecycleCommand("skip", "cancel"),
  },
});
const check = defineCommand({
  meta: { name: "check", description: "List or refresh declared checks" },
  subCommands: {
    list: queryCommand("list", "phases"),
    run: lifecycleCommand("run", "remediate"),
  },
});
const explore = defineCommand({
  meta: {
    name: "explore",
    description: "Exploration operations are service-backed",
  },
  subCommands: {
    list: queryCommand("list", "projects", false),
    show: queryCommand("show", "projects", false),
    start: lifecycleCommand("start", "start"),
    resume: lifecycleCommand("resume", "resume"),
    discard: lifecycleCommand("discard", "cancel"),
    promote: lifecycleCommand("promote", "start"),
  },
});

const main = defineCommand({
  meta: {
    name: "swf",
    version: "0.1.0",
    description: "Agentic software factory",
  },
  subCommands: {
    doctor,
    init,
    setup,
    service,
    status,
    events,
    artifacts,
    log: logs,
    cost: costs,
    config: configuration,
    pause,
    resume,
    cancel,
    approve,
    reject,
    rollback,
    input: blockedInput,
    explore,
    new: newRun,
    run: automaticRun,
    next,
    phase,
    check,
  },
});
await runMain(main);
