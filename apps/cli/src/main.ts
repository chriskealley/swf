#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { defineCommand, runMain } from "citty";
import consola from "consola";
import { detectPackageManager } from "nypm";
import {
  ServiceUnavailableError,
  SwfServiceClient,
  applySetupPlan,
  createSetupPlan,
  findProjectRoot,
  initializeProject,
  readLocalServiceMetadata,
  readProjectConfig,
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
async function connectedProject(cwd = process.cwd()): Promise<{
  active: SwfServiceClient;
  projectId: string;
  root: string;
}> {
  const project = await findProjectRoot(cwd);
  if (!project?.initialized)
    throw new Error(
      "No initialized SWF project was found from the current directory",
    );
  const config = await readProjectConfig(project);
  const active = await client();
  await active.registerProject({
    projectId: config.projectId,
    displayName: basename(project.root),
    root: project.root,
  });
  return { active, projectId: config.projectId, root: project.root };
}
async function boundRunId(
  active: SwfServiceClient,
  projectId: string,
  changeName: string,
): Promise<string> {
  const runs = await active.query<Array<{ runId: string; changeName: string }>>(
    "runs",
    { projectId },
  );
  const run = runs.find((candidate) => candidate.changeName === changeName);
  if (!run) throw new Error(`No run is bound to ${changeName}`);
  return run.runId;
}
function publicServiceMetadata<T extends { credential?: string }>(metadata: T) {
  const { credential: _credential, ...safe } = metadata;
  return { ...safe, credentialConfigured: Boolean(_credential) };
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
    let registration: unknown;
    if (result.status !== "untrusted") {
      try {
        const config = await readProjectConfig(result.project);
        registration = await (
          await client()
        ).registerProject({
          projectId: config.projectId,
          displayName: basename(result.project.root),
          root: result.project.root,
        });
      } catch (error) {
        if (!(error instanceof ServiceUnavailableError)) throw error;
        registration = { status: "service-unavailable", deferred: true };
      }
    }
    output({ ...result, registration }, args.json);
    if (result.status === "untrusted") process.exitCode = 1;
  },
});

const serviceStatus = defineCommand({
  meta: { name: "status", description: "Show local service status" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    try {
      output(
        publicServiceMetadata(await readLocalServiceMetadata()),
        args.json,
      );
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
      output(
        publicServiceMetadata(await readLocalServiceMetadata()),
        args.json,
      );
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
    output(
      {
        started: true,
        pid: child.pid,
        metadata: publicServiceMetadata(metadata),
      },
      args.json,
    );
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
      const [projects, adapters] = await Promise.all([
        active.query("projects"),
        active.query("adapters"),
      ]);
      output(
        {
          metadata: publicServiceMetadata(active.metadata),
          projects,
          adapters,
        },
        args.json,
      );
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
      authorized: { type: "boolean" },
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
        authorized?: boolean;
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
          authorized: input.authorized,
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
const budgets = queryCommand("budget", "budgets");
const operations = queryCommand("operations", "operations", false);
const configuration = queryCommand("config", "configuration", false);
const pause = lifecycleCommand("pause", "pause");
const resume = lifecycleCommand("resume", "resume");
const cancel = lifecycleCommand("cancel", "cancel");
const approve = lifecycleCommand("approve", "approve");
const reject = lifecycleCommand("reject", "reject");
const requestChanges = lifecycleCommand("request-changes", "request-changes");
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

function workflowEntryCommand(type: "new" | "run" | "next") {
  return defineCommand({
    meta: {
      name: type,
      description:
        type === "new"
          ? "Create a change/run, execute its first phase, and stop"
          : type === "run"
            ? "Create or resume a change/run with automatic progression"
            : "Execute exactly the next eligible phase and stop",
    },
    args: {
      change: { type: "positional", required: true },
      description: { type: "string" },
      workflow: { type: "string" },
      policy: { type: "string" },
      "authorize-autonomous": { type: "boolean" },
      actor: { type: "string" },
      "from-exploration": { type: "string" },
      cwd: { type: "string" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      try {
        const { active, projectId } = await connectedProject(args.cwd);
        const result = await active.command({
          type,
          projectId,
          changeName: args.change,
          description: args.description,
          workflowId: args.workflow,
          policyId: args.policy,
          fromExplorationId: args["from-exploration"],
          authorization: args["authorize-autonomous"]
            ? {
                authorizationId: crypto.randomUUID(),
                delegatedBy: { type: "user", id: args.actor ?? "operator" },
                scope: "project",
                scopeId: projectId,
                acknowledgedAt: new Date().toISOString(),
                configurationSource: "cli:--authorize-autonomous",
              }
            : undefined,
        });
        output(result, args.json);
      } catch (error) {
        fail(error, args.json);
      }
    },
  });
}

const newRun = workflowEntryCommand("new");
const automaticRun = workflowEntryCommand("run");
const next = workflowEntryCommand("next");
const runNamedPhase = defineCommand({
  meta: {
    name: "run",
    description: "Execute exactly one named eligible phase",
  },
  args: {
    change: { type: "positional", required: true },
    phase: { type: "positional", required: true },
    cwd: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const { active, projectId } = await connectedProject(args.cwd);
      output(
        await active.command({
          type: "phase-run",
          projectId,
          changeName: args.change,
          phaseId: args.phase,
        }),
        args.json,
      );
    } catch (error) {
      fail(error, args.json);
    }
  },
});
function phaseQueryCommand(name: "list" | "status" | "explain") {
  return defineCommand({
    meta: { name, description: `${name} workflow phase state` },
    args: {
      change: { type: "positional", required: true },
      phase: { type: "positional", required: name !== "list" },
      cwd: { type: "string" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      try {
        const { active, projectId } = await connectedProject(args.cwd);
        const runId = await boundRunId(active, projectId, args.change);
        output(
          await active.query("phases", {
            projectId,
            runId,
            phaseId: args.phase,
          }),
          args.json,
        );
      } catch (error) {
        fail(error, args.json);
      }
    },
  });
}
function phaseMutationCommand(type: "phase-rerun" | "phase-skip") {
  return defineCommand({
    meta: { name: type.slice("phase-".length), description: `${type} a phase` },
    args: {
      change: { type: "positional", required: true },
      phase: { type: "positional", required: true },
      authorized: { type: "boolean" },
      cwd: { type: "string" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      try {
        const { active, projectId } = await connectedProject(args.cwd);
        output(
          await active.command({
            type,
            projectId,
            changeName: args.change,
            phaseId: args.phase,
            authorized: Boolean(args.authorized),
          }),
          args.json,
        );
      } catch (error) {
        fail(error, args.json);
      }
    },
  });
}
const phase = defineCommand({
  meta: { name: "phase", description: "Inspect or control a named phase" },
  subCommands: {
    list: phaseQueryCommand("list"),
    status: phaseQueryCommand("status"),
    explain: phaseQueryCommand("explain"),
    run: runNamedPhase,
    rerun: phaseMutationCommand("phase-rerun"),
    skip: phaseMutationCommand("phase-skip"),
  },
});
const check = defineCommand({
  meta: { name: "check", description: "List or refresh declared checks" },
  subCommands: {
    discover: defineCommand({
      meta: {
        name: "discover",
        description: "Preview read-only project check discovery",
      },
      args: { cwd: { type: "string" }, json: { type: "boolean" } },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(
            await active.query("check-discovery", { projectId }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    adopt: defineCommand({
      meta: {
        name: "adopt",
        description: "Adopt selected discovered checks after review",
      },
      args: {
        ids: { type: "string", required: true },
        apply: { type: "boolean" },
        cwd: { type: "string" },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          const selectedIds = args.ids
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          output(
            await active.command({
              type: args.apply ? "checks-apply" : "checks-preview",
              projectId,
              selectedIds,
              confirmed: Boolean(args.apply),
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    list: phaseQueryCommand("list"),
    run: defineCommand({
      meta: { name: "run", description: "Refresh one declared check" },
      args: {
        change: { type: "positional", required: true },
        check: { type: "positional", required: true },
        cwd: { type: "string" },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(
            await active.command({
              type: "check-run",
              projectId,
              changeName: args.change,
              checkId: args.check,
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
  },
});
const prune = defineCommand({
  meta: {
    name: "prune",
    description: "Preview or confirm raw-output retention pruning",
  },
  args: {
    project: { type: "string", required: true },
    age: { type: "string" },
    run: { type: "string" },
    budget: { type: "string" },
    confirm: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const active = await client();
      const result = args.confirm
        ? await active.confirmPruning(args.project, args.confirm)
        : await active.previewPruning(args.project, {
            ageDays: args.age ? Number(args.age) : undefined,
            runId: args.run,
            budgetBytes: args.budget ? Number(args.budget) : undefined,
          });
      output(result, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const reconcile = defineCommand({
  meta: {
    name: "reconcile",
    description: "Report stuck agents and orphaned owned resources",
  },
  args: {
    project: { type: "string", required: true },
    apply: { type: "boolean" },
    "stale-after-ms": { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const result = await (
        await client()
      ).command({
        type: "reconcile",
        projectId: args.project,
        apply: Boolean(args.apply),
        staleAfterMs: args["stale-after-ms"]
          ? Number(args["stale-after-ms"])
          : undefined,
      });
      output(result, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const migrate = defineCommand({
  meta: {
    name: "migrate",
    description: "Preview, apply, or roll back state migrations",
  },
  args: {
    project: { type: "string", required: true },
    target: { type: "string" },
    apply: { type: "boolean" },
    rollback: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const result = await (
        await client()
      ).command({
        type: "migrate",
        projectId: args.project,
        target: args.target ? Number(args.target) : undefined,
        dryRun: !args.apply,
        rollbackBackupId: args.rollback,
      });
      output(result, args.json);
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const transfer = defineCommand({
  meta: { name: "transfer", description: "Export or import complete runs" },
  subCommands: {
    export: defineCommand({
      meta: { name: "export", description: "Export complete run history" },
      args: {
        project: { type: "string", required: true },
        run: { type: "string", required: true },
        path: { type: "positional", required: true },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          output(
            await (
              await client()
            ).command({
              type: "export-run",
              projectId: args.project,
              runId: args.run,
              path: args.path,
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    import: defineCommand({
      meta: { name: "import", description: "Import complete run history" },
      args: {
        project: { type: "string", required: true },
        path: { type: "positional", required: true },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          output(
            await (
              await client()
            ).command({
              type: "import-run",
              projectId: args.project,
              path: args.path,
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
  },
});
const delivery = defineCommand({
  meta: {
    name: "delivery",
    description: "Inspect, start, or refresh configured delivery",
  },
  subCommands: {
    status: queryCommand("status", "delivery"),
    start: lifecycleCommand("start", "deliver"),
    refresh: lifecycleCommand("refresh", "refresh-delivery"),
  },
});
const model = defineCommand({
  meta: {
    name: "model",
    description: "Inspect and explicitly configure model-tier routes",
  },
  subCommands: {
    routes: defineCommand({
      meta: {
        name: "routes",
        description: "Show effective model-tier diagnostics",
      },
      args: { cwd: { type: "string" }, json: { type: "boolean" } },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(await active.query("model-routes", { projectId }), args.json);
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    map: defineCommand({
      meta: {
        name: "map",
        description: "Preview or apply one explicit tier mapping",
      },
      args: {
        tier: { type: "positional", required: true },
        harness: { type: "positional", required: true },
        model: { type: "positional", required: true },
        apply: { type: "boolean" },
        cwd: { type: "string" },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(
            await active.command({
              type: args.apply ? "model-map-apply" : "model-map-preview",
              projectId,
              tier: args.tier,
              harness: args.harness,
              model: args.model,
              confirmed: Boolean(args.apply),
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
  },
});
const defaults = defineCommand({
  meta: {
    name: "defaults",
    description:
      "Inspect default-template state without changing project files",
  },
  args: {
    paths: { type: "string" },
    apply: { type: "boolean" },
    cwd: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const { active, projectId } = await connectedProject(args.cwd);
      if (!args.apply)
        output(await active.query("defaults", { projectId }), args.json);
      else
        output(
          await active.command({
            type: "defaults-adopt",
            projectId,
            selectedPaths: (args.paths ?? "")
              .split(",")
              .map((path) => path.trim())
              .filter(Boolean),
            confirmed: true,
          }),
          args.json,
        );
    } catch (error) {
      fail(error, args.json);
    }
  },
});
const archive = defineCommand({
  meta: {
    name: "archive",
    description: "Explicitly archive a successfully delivered OpenSpec change",
  },
  args: {
    project: { type: "string", required: true },
    run: { type: "string", required: true },
    authorized: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      output(
        await (
          await client()
        ).command({
          type: "archive-change",
          projectId: args.project,
          runId: args.run,
          authorized: Boolean(args.authorized),
        }),
        args.json,
      );
    } catch (error) {
      fail(error, args.json);
    }
  },
});
function explorationIdentityCommand(
  name: "show" | "resume" | "discard" | "promote",
) {
  return defineCommand({
    meta: { name, description: `${name} an explicit durable exploration` },
    args: {
      exploration: { type: "positional", required: true },
      cwd: { type: "string" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      try {
        const { active, projectId } = await connectedProject(args.cwd);
        const result =
          name === "show"
            ? await active.query("exploration", {
                projectId,
                ref: args.exploration,
              })
            : await active.command({
                type: `explore-${name}`,
                projectId,
                explorationId: args.exploration,
              });
        output(result, args.json);
      } catch (error) {
        fail(error, args.json);
      }
    },
  });
}
const explore = defineCommand({
  meta: {
    name: "explore",
    description: "Create and manage durable read-only explorations",
  },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Start a read-only exploration" },
      args: {
        idea: { type: "positional", required: true },
        candidate: { type: "string" },
        cwd: { type: "string" },
        json: { type: "boolean" },
      },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(
            await active.command({
              type: "explore-start",
              projectId,
              idea: args.idea,
              candidateChangeName: args.candidate,
            }),
            args.json,
          );
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List durable explorations" },
      args: { cwd: { type: "string" }, json: { type: "boolean" } },
      async run({ args }) {
        try {
          const { active, projectId } = await connectedProject(args.cwd);
          output(await active.query("explorations", { projectId }), args.json);
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
    show: explorationIdentityCommand("show"),
    resume: explorationIdentityCommand("resume"),
    discard: explorationIdentityCommand("discard"),
    promote: explorationIdentityCommand("promote"),
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
    budget: budgets,
    operations,
    prune,
    reconcile,
    migrate,
    transfer,
    config: configuration,
    pause,
    resume,
    cancel,
    approve,
    reject,
    "request-changes": requestChanges,
    rollback,
    input: blockedInput,
    explore,
    new: newRun,
    run: automaticRun,
    next,
    phase,
    check,
    delivery,
    model,
    defaults,
    archive,
  },
});
await runMain(main);
