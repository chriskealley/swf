#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { defineCommand, runMain } from "citty";
import consola from "consola";
import { detectPackageManager } from "nypm";
import {
  ServiceUnavailableError,
  SwfOperatorError,
  SwfServiceClient,
  applySetupPlan,
  createSetupPlan,
  findProjectRoot,
  initializeProject,
  readLocalServiceMetadata,
  readProjectConfig,
  runDoctor,
  UnsupportedManagedServiceError,
  applyManagedServicePlan,
  createManagedServicePlan,
  createServiceLaunchPlan,
  developmentProductMetadata,
  expectedPackagedServiceEntry,
  CLEANUP_SCOPES,
  applyCleanup,
  diagnoseManagedService,
  discardCleanupPreview,
  loadCleanupPreview,
  persistCleanupPreview,
  previewCleanup,
  renderCleanupPreview,
  type CleanupScope,
  evaluateUpgradePreflight,
  renderUpgradePreflight,
  manualFallbackGuidance,
  previewManagedServiceRepair,
  renderManagedServicePlan,
  uninstallManagedService,
  listServiceLogs,
  readServiceLogTail,
  resolvePackagedServiceEntry,
  startPackagedService,
  evaluateCompatibility,
  readProductMetadata,
  type ProductMetadata,
  type CheckStatus,
  type SetupAction,
} from "@swf/core";
import {
  AmbiguousOperatorContextError,
  resolveOperatorContext,
  resolveUniqueAction,
  type OperatorContext,
} from "./operator-context.js";
import {
  projectionFromResult,
  renderActionCommand,
  renderOperatorError,
  renderOperatorProjection,
} from "./operator-renderer.js";
import { OrderedProgressSubscriber, renderProgressLine } from "./progress.js";
import {
  approvalChoices,
  interactionEnabled,
  runApprovalDecisionFlow,
} from "./interaction.js";

const SCHEMA_VERSION = 1;
function output(value: unknown, json = false, verbose = false): void {
  if (json)
    console.log(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, result: value }, null, 2),
    );
  else {
    const projection = projectionFromResult(value);
    consola.log(
      projection
        ? renderOperatorProjection(projection, { verbose })
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2),
    );
  }
}
function fail(error: unknown, json = false, verbose = false): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (json)
    console.log(
      JSON.stringify(
        error instanceof SwfOperatorError
          ? {
              schemaVersion: SCHEMA_VERSION,
              error: error.detail,
              projection: error.projection,
            }
          : {
              schemaVersion: SCHEMA_VERSION,
              error: {
                schemaVersion: SCHEMA_VERSION,
                code: "SWF_ERROR",
                category: "infrastructure",
                message,
                retryable: false,
                diagnosticRefs: [],
                recoveryActions: [],
              },
            },
        null,
        2,
      ),
    );
  else if (error instanceof SwfOperatorError)
    consola.error(
      renderOperatorError(error.detail, error.projection, { verbose }),
    );
  else if (error instanceof AmbiguousOperatorContextError) {
    consola.error(message);
    for (const alternative of error.alternatives)
      consola.error(
        `  ${Object.entries(alternative)
          .filter(([, value]) => value)
          .map(
            ([key, value]) =>
              `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${value}`,
          )
          .join(" ")}`,
      );
  } else consola.error(message);
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

interface ContextArgs {
  change?: string;
  cwd?: string;
  project?: string;
  run?: string;
}

async function selectedContext(
  active: SwfServiceClient,
  args: ContextArgs,
): Promise<OperatorContext> {
  if (args.project)
    return resolveOperatorContext({
      client: active,
      projectId: args.project,
      runId: args.run,
      changeName: args.change,
    });
  const connected = await connectedProject(args.cwd);
  return resolveOperatorContext({
    client: active,
    projectId: connected.projectId,
    runId: args.run,
    changeName: args.change,
  });
}

function startProgress(
  active: SwfServiceClient,
  context: { projectId?: string; runId?: string },
  enabled: boolean,
): { stop: () => Promise<void> } {
  if (!enabled) return { stop: async () => undefined };
  const controller = new AbortController();
  const subscriber = new OrderedProgressSubscriber(
    (line) =>
      console.error(renderProgressLine(line, Boolean(process.stderr.isTTY))),
    context,
  );
  const following = subscriber.follow(
    (after) => active.events({ after, signal: controller.signal }),
    { attempts: 3 },
  );
  return {
    stop: async () => {
      controller.abort();
      await following.catch(() => undefined);
    },
  };
}
function publicServiceMetadata<T extends { credential?: string }>(metadata: T) {
  const { credential: _credential, ...safe } = metadata;
  return { ...safe, credentialConfigured: Boolean(_credential) };
}
/**
 * Packaged installations carry assembled build metadata; a source checkout has
 * none, so fall back to a clearly-labelled development identity rather than
 * reporting a version the build never produced.
 */
async function resolveProductMetadata(): Promise<ProductMetadata> {
  try {
    return await readProductMetadata();
  } catch {
    return developmentProductMetadata();
  }
}

function productVersionLabel(metadata: ProductMetadata): string {
  const { productVersion, channel, sourceCommit, sourceDirty } = metadata.build;
  if (channel !== "development") return productVersion;
  const commit =
    sourceCommit === "unknown" ? "unknown" : sourceCommit.slice(0, 12);
  return `${productVersion} (development ${commit}${sourceDirty ? "-dirty" : ""})`;
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
    port: { type: "string", description: "Loopback port (default 34671)" },
    command: {
      type: "string",
      description:
        "Override the launch command. Only for source checkouts; an installed product launches its packaged service entry directly.",
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

    const port = Number.parseInt(args.port ?? "34671", 10);
    const serviceHome =
      process.env.SWF_SERVICE_HOME ??
      process.env.SWF_CONFIG_HOME ??
      join(process.env.HOME ?? process.cwd(), ".config", "swf");

    // An installed product launches its own compiled entry. A source checkout
    // has no packaged entry, so it falls back to the workspace dev server.
    const packagedEntry = await resolvePackagedServiceEntry();
    if (!packagedEntry) {
      const fallback =
        args.command ?? "pnpm --filter @swf/service dev --host=127.0.0.1";
      const [command, ...commandArgs] = fallback.split(" ");
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
          mode: "source-checkout",
          pid: child.pid,
          metadata: publicServiceMetadata(metadata),
        },
        args.json,
      );
      return;
    }

    const plan = createServiceLaunchPlan({
      serviceEntry: packagedEntry,
      serviceHome,
      port,
    });
    try {
      const started = await startPackagedService(plan, {
        clientVersion: productMetadata.build.productVersion,
        clientApiProtocolVersion:
          productMetadata.compatibility.apiProtocolVersion,
      });
      output(
        {
          started: true,
          mode: "packaged",
          pid: started.pid,
          endpoint: plan.endpoint,
          serviceHome: plan.serviceHome,
          logPath: started.logPath,
          product: started.health?.product,
          metadata: publicServiceMetadata(await readLocalServiceMetadata()),
        },
        args.json,
      );
    } catch (error) {
      fail(error, args.json);
    }
  },
});

const serviceLogs = defineCommand({
  meta: {
    name: "logs",
    description: "Print a bounded redacted tail of the service log",
  },
  args: {
    json: { type: "boolean" },
    lines: { type: "string", description: "Lines to show (default 40)" },
  },
  async run({ args }) {
    try {
      const serviceHome =
        process.env.SWF_SERVICE_HOME ??
        process.env.SWF_CONFIG_HOME ??
        join(process.env.HOME ?? process.cwd(), ".config", "swf");
      const logPath = join(serviceHome, "logs", "service.log");
      const tail = await readServiceLogTail(
        logPath,
        Number.parseInt(args.lines ?? "40", 10),
      );
      const retained = await listServiceLogs(serviceHome);
      if (args.json) return output({ ...tail, retained }, true);
      consola.log(tail.path);
      if (tail.truncated) consola.info("(older lines omitted)");
      consola.log(tail.lines.join("\n") || "(empty)");
      if (retained.length > 1) consola.info(`retained: ${retained.join(", ")}`);
    } catch (error) {
      fail(error, args.json);
    }
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
/**
 * Builds a managed-service plan. Diagnostics must work even when the packaged
 * entry is missing, so `forDiagnosis` falls back to the path the entry would
 * occupy rather than refusing outright.
 */
async function managedPlanForCurrentProduct(
  runAtLoad: boolean,
  forDiagnosis = false,
) {
  const serviceHome =
    process.env.SWF_SERVICE_HOME ??
    process.env.SWF_CONFIG_HOME ??
    join(process.env.HOME ?? process.cwd(), ".config", "swf");
  const entry = forDiagnosis
    ? await expectedPackagedServiceEntry()
    : await resolvePackagedServiceEntry();
  if (!entry)
    throw new Error(
      "Managed services require an installed product. A source checkout has no packaged service entry.",
    );
  return createManagedServicePlan({
    launch: createServiceLaunchPlan({
      serviceEntry: entry,
      serviceHome,
      port: 34671,
    }),
    runAtLoad,
  });
}

const serviceInstall = defineCommand({
  meta: {
    name: "install",
    description: "Preview or install the user-scoped managed service",
  },
  args: {
    json: { type: "boolean" },
    apply: { type: "boolean", description: "Write the definition" },
    yes: { type: "boolean", description: "Confirm the previewed plan" },
    repair: { type: "boolean", description: "Rewrite a stale definition" },
    "at-login": {
      type: "boolean",
      description: "Start automatically at login",
    },
  },
  async run({ args }) {
    try {
      const plan = await managedPlanForCurrentProduct(
        Boolean(args["at-login"]),
      );
      if (args.repair) {
        const preview = await previewManagedServiceRepair(plan);
        if (!args.apply) return output(preview, args.json);
        if (!args.yes)
          throw new Error(
            "Refusing to repair without --yes. Review the preview first.",
          );
      } else if (!args.apply) {
        if (args.json) return output(plan, true);
        consola.log(renderManagedServicePlan(plan));
        consola.info(
          "Nothing has been changed. Re-run with --apply --yes to install.",
        );
        return;
      } else if (!args.yes)
        throw new Error(
          "Refusing to install without --yes. Review the preview first.",
        );

      const result = await applyManagedServicePlan(plan, { confirmed: true });
      if (args.json) return output(result, true);
      consola.success(`Wrote ${result.definitionPath}`);
      consola.info("Enable it yourself when ready:");
      for (const command of result.pendingCommands)
        consola.log(`  ${command.join(" ")}`);
    } catch (error) {
      fail(error, args.json);
    }
  },
});

const serviceUninstall = defineCommand({
  meta: {
    name: "uninstall",
    description: "Preview or remove the user-scoped managed service",
  },
  args: {
    json: { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const plan = await managedPlanForCurrentProduct(false, true);
      if (!args.apply) {
        const diagnostics = await diagnoseManagedService(plan);
        if (args.json)
          return output(
            {
              definitionPath: plan.definitionPath,
              diagnostics,
              preserved: [plan.environment.SWF_SERVICE_HOME],
            },
            true,
          );
        consola.log(`Would remove ${plan.definitionPath}`);
        consola.info(
          `Preserved: ${plan.environment.SWF_SERVICE_HOME} and all project state`,
        );
        consola.info("Re-run with --apply --yes to remove it.");
        return;
      }
      if (!args.yes)
        throw new Error(
          "Refusing to remove without --yes. Review the preview first.",
        );
      const result = await uninstallManagedService(plan, { confirmed: true });
      if (args.json) return output(result, true);
      consola.success(
        result.removed
          ? `Removed ${result.definitionPath}`
          : `No definition at ${result.definitionPath}`,
      );
      for (const command of result.pendingCommands)
        consola.log(`  ${command.join(" ")}`);
      consola.info(`Preserved: ${result.preservedPaths.join(", ")}`);
    } catch (error) {
      fail(error, args.json);
    }
  },
});

const serviceDoctorManaged = defineCommand({
  meta: {
    name: "check",
    description: "Diagnose the installed managed service definition",
  },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    try {
      const plan = await managedPlanForCurrentProduct(false, true);
      const diagnostics = await diagnoseManagedService(plan);
      if (args.json) return output({ diagnostics }, true);
      for (const finding of diagnostics) {
        consola.log(`${finding.id}: ${finding.detail}`);
        if (finding.remediation) consola.info(`  ${finding.remediation}`);
      }
    } catch (error) {
      if (error instanceof UnsupportedManagedServiceError) {
        for (const line of manualFallbackGuidance()) consola.info(line);
        return;
      }
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
    logs: serviceLogs,
    install: serviceInstall,
    uninstall: serviceUninstall,
    check: serviceDoctorManaged,
    diagnostic: serviceDiagnostic,
  },
});

function queryCommand(
  name: string,
  resource: string,
  options: { needsRun?: boolean; projection?: boolean } = {},
) {
  const { needsRun = true, projection = false } = options;
  return defineCommand({
    meta: { name, description: `Query SWF ${resource}` },
    args: {
      change: { type: "positional", required: false },
      project: {
        type: "string",
        description: "Advanced: explicit project ID",
      },
      run: { type: "string", description: "Advanced: explicit run ID" },
      cwd: { type: "string" },
      verbose: { type: "boolean" },
      json: { type: "boolean" },
    },
    async run({
      args,
    }: {
      args: ContextArgs & { json?: boolean; verbose?: boolean };
    }) {
      try {
        const active = await client();
        if (needsRun) {
          const context = await selectedContext(active, args);
          const result = projection
            ? { projection: context.projection }
            : await active.query(resource, {
                projectId: context.projectId,
                runId: context.runId,
              });
          output(result, args.json, args.verbose);
          return;
        }
        output(
          await active.query(resource, {
            projectId:
              args.project ?? (await connectedProject(args.cwd)).projectId,
            runId: args.run,
          }),
          args.json,
          args.verbose,
        );
      } catch (error) {
        fail(error, args.json, args.verbose);
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
      change: { type: "positional", required: false },
      project: { type: "string", description: "Advanced: explicit project ID" },
      run: { type: "string", description: "Advanced: explicit run ID" },
      phase: { type: "string" },
      gate: { type: "string" },
      checkpoint: { type: "string" },
      reason: { type: "string" },
      actor: { type: "string" },
      authorized: { type: "boolean" },
      cwd: { type: "string" },
      verbose: { type: "boolean" },
      interactive: { type: "boolean" },
      "no-interactive": { type: "boolean" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      const input = args as unknown as {
        change?: string;
        project?: string;
        run?: string;
        phase?: string;
        gate?: string;
        checkpoint?: string;
        reason?: string;
        actor?: string;
        authorized?: boolean;
        cwd?: string;
        verbose?: boolean;
        json?: boolean;
      };
      try {
        const active = await client();
        const context = await selectedContext(active, input);
        const semanticTypes = {
          approve: ["approve"],
          reject: ["reject"],
          "request-changes": ["request-changes"],
        } as const;
        const semantic =
          type in semanticTypes && (!input.phase || !input.gate)
            ? resolveUniqueAction(context.projection, [
                ...semanticTypes[type as keyof typeof semanticTypes],
              ])
            : undefined;
        const result = await active.command({
          type,
          projectId: context.projectId,
          runId: context.runId,
          phaseId: input.phase ?? semantic?.parameters.phaseId,
          gateId: input.gate ?? semantic?.parameters.gateId,
          checkpointId: input.checkpoint,
          reason: input.reason,
          actorId: input.actor ?? "operator",
          authorized: input.authorized,
          ...extras,
        });
        output(result, input.json, input.verbose);
      } catch (error) {
        fail(error, input.json, input.verbose);
      }
    },
  });
}

const status = queryCommand("status", "run", { projection: true });
const events = queryCommand("events", "run");
const artifacts = queryCommand("artifacts", "artifacts");
const logs = queryCommand("log", "invocations");
const costs = queryCommand("cost", "costs");
const budgets = queryCommand("budget", "budgets");
const operations = queryCommand("operations", "operations", {
  needsRun: false,
});
const configuration = queryCommand("config", "configuration", {
  needsRun: false,
});
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
    change: { type: "positional", required: false },
    response: { type: "positional", required: false },
    invocation: {
      type: "string",
      description: "Advanced: explicit invocation ID",
    },
    project: { type: "string", description: "Advanced: explicit project ID" },
    run: { type: "string", description: "Advanced: explicit run ID" },
    cwd: { type: "string" },
    verbose: { type: "boolean" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    try {
      const positionals = ((args._ as string[] | undefined) ?? []).filter(
        Boolean,
      );
      const [change, response] =
        positionals.length > 1
          ? [positionals[0], positionals.slice(1).join(" ")]
          : [undefined, positionals[0]];
      if (!response)
        throw new Error(
          "A response is required: swf input [change] <response>",
        );
      const active = await client();
      let runId = args.run;
      if (!runId && !change && args.invocation) {
        const blocked =
          await active.query<Array<{ invocationId: string; runId: string }>>(
            "blocked-inputs",
          );
        runId = blocked.find(
          ({ invocationId }) => invocationId === args.invocation,
        )?.runId;
      }
      const context = await selectedContext(active, {
        ...args,
        change,
        run: runId,
      });
      const semantic = args.invocation
        ? undefined
        : resolveUniqueAction(context.projection, ["reply-to-invocation"]);
      const result = await active.command({
        type: "blocked-input",
        projectId: context.projectId,
        runId: context.runId,
        invocationId: args.invocation ?? semantic?.parameters.invocationId,
        response,
      });
      output(result, args.json, args.verbose);
    } catch (error) {
      fail(error, args.json, args.verbose);
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
      verbose: { type: "boolean" },
      interactive: {
        type: "boolean",
        description: "Offer a TTY approval menu when a gate blocks the run",
      },
      "no-interactive": { type: "boolean" },
      json: { type: "boolean" },
    },
    async run({ args }) {
      try {
        const { active, projectId } = await connectedProject(args.cwd);
        const progress = startProgress(active, { projectId }, !args.json);
        try {
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
          output(result, args.json, args.verbose);
          const projection = projectionFromResult(result);
          if (
            projection &&
            projection.attention.some(
              ({ type }) => type === "manual-approval",
            ) &&
            interactionEnabled({
              interactive: Boolean(args.interactive),
              noInteractive: Boolean(args["no-interactive"]),
              json: Boolean(args.json),
              stdinTty: Boolean(process.stdin.isTTY),
              stdoutTty: Boolean(process.stdout.isTTY),
              ci: Boolean(process.env.CI),
            })
          ) {
            const flow = await runApprovalDecisionFlow({
              projection,
              actor: args.actor ?? "operator",
              choose: async (choices) => {
                const selected = await consola.prompt("Choose an action", {
                  type: "select",
                  options: choices.map(({ label, action }) => ({
                    label,
                    value: action?.actionId ?? "exit",
                  })),
                  initial: "exit",
                });
                return projection.allowedActions.find(
                  ({ actionId }) => actionId === selected,
                );
              },
              confirm: (action) =>
                consola.prompt(`Confirm: ${action.label}?`, {
                  type: "confirm",
                  initial: false,
                }),
              reason: async (action) =>
                action.type === "approve"
                  ? undefined
                  : consola.prompt("Reason", { type: "text" }),
              submit: (decision) => active.command(decision),
            });
            if (flow.status === "review") {
              const review = approvalChoices(projection).find(
                ({ action }) => action?.type === "inspect-evidence",
              )?.action;
              if (review) consola.log(`Review: ${renderActionCommand(review)}`);
            } else if (flow.status === "submitted")
              output(flow.result, false, args.verbose);
          }
        } finally {
          await progress.stop();
        }
      } catch (error) {
        fail(error, args.json, args.verbose);
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

const productMetadata = await resolveProductMetadata();

/**
 * Opens the dashboard served by the packaged loopback service. The bearer
 * credential is never placed on the command line or in the URL query, where it
 * would reach shell history and server logs.
 */
const dashboard = defineCommand({
  meta: {
    name: "dashboard",
    description: "Open or print the local dashboard URL",
  },
  subCommands: {
    open: defineCommand({
      meta: { name: "open", description: "Open the packaged dashboard" },
      args: {
        json: { type: "boolean" },
        "no-open": { type: "boolean" },
      },
      async run({ args }) {
        try {
          const metadata = await readLocalServiceMetadata();
          const url = `${metadata.endpoint.replace(/\/$/, "")}/dashboard/`;
          const compatibility = await dashboardCompatibility(metadata.endpoint);
          if (args.json) return output({ url, compatibility }, true);
          consola.log(url);
          if (compatibility?.length)
            for (const warning of compatibility) consola.warn(warning);
          if (!args["no-open"]) await openInBrowser(url);
        } catch (error) {
          fail(error, args.json);
        }
      },
    }),
  },
});

/**
 * Compares the running service against this CLI before pointing a browser at
 * it, so an incompatible pair is reported rather than silently misbehaving.
 */
async function dashboardCompatibility(
  endpoint: string,
): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/health`);
    if (!response.ok) return undefined;
    const health = (await response.json()) as {
      compatibility?: Parameters<typeof evaluateCompatibility>[0];
    };
    if (!health.compatibility) return undefined;
    const report = evaluateCompatibility(health.compatibility, {
      clientVersion: productMetadata.build.productVersion,
      clientApiProtocolVersion:
        productMetadata.compatibility.apiProtocolVersion,
    });
    return report.compatible
      ? undefined
      : report.findings
          .filter(({ status }) => status === "incompatible")
          .map(({ detail, remediation }) =>
            remediation ? `${detail}. ${remediation}` : detail,
          );
  } catch {
    return undefined;
  }
}

async function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const commandArgs = [url];
  await new Promise<void>((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const upgrade = defineCommand({
  meta: {
    name: "upgrade",
    description:
      "Preview what an installed product upgrade requires. Changes nothing.",
  },
  args: {
    json: { type: "boolean" },
    project: { type: "string" },
    cwd: { type: "string" },
  },
  async run({ args }) {
    try {
      // The running service is optional: a package manager can replace product
      // files while the old service is still running, which is exactly the
      // skew this preview exists to explain.
      const running = await (async () => {
        try {
          const metadata = await readLocalServiceMetadata();
          const response = await fetch(`${metadata.endpoint}/api/health`, {
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) return undefined;
          const health = (await response.json()) as {
            product?: { productVersion?: string; sourceCommit?: string };
            compatibility?: {
              apiProtocolVersion?: number;
              stateSchemaVersion?: number;
            };
          };
          return {
            productVersion: health.product?.productVersion,
            sourceCommit: health.product?.sourceCommit,
            apiProtocolVersion: health.compatibility?.apiProtocolVersion,
            stateSchemaVersion: health.compatibility?.stateSchemaVersion,
          };
        } catch {
          return undefined;
        }
      })();

      const managed = await (async () => {
        try {
          return await diagnoseManagedService(
            await managedPlanForCurrentProduct(false, true),
          );
        } catch {
          return undefined;
        }
      })();

      // Reuse the existing migration machinery rather than re-deriving a plan:
      // the service owns backups, verification, and rollback.
      const migrationPlan = await (async () => {
        if (!args.project) return undefined;
        try {
          const result = (await (
            await client()
          ).command({
            type: "migrate",
            projectId: args.project,
            dryRun: true,
          })) as { plan?: { from: number; to: number; migrations: [] } };
          return result.plan;
        } catch {
          return undefined;
        }
      })();

      const preflight = evaluateUpgradePreflight({
        installed: productMetadata,
        runningService: running,
        managedService: managed,
        migrationPlan,
      });
      if (args.json) return output(preflight, true);
      consola.log(renderUpgradePreflight(preflight));
      if (preflight.blocked) process.exitCode = 1;
    } catch (error) {
      fail(error, args.json);
    }
  },
});

const cleanup = defineCommand({
  meta: {
    name: "cleanup",
    description:
      "Preview or apply scoped removal of SWF operational data. Never implied by uninstall.",
  },
  args: {
    json: { type: "boolean" },
    scope: {
      type: "string",
      description: `Comma-separated: ${CLEANUP_SCOPES.join(", ")}`,
    },
    project: {
      type: "string",
      description: "Project state directory to include (repeatable via commas)",
    },
    apply: { type: "boolean" },
    confirm: {
      type: "string",
      description: "Confirmation id from the preview",
    },
  },
  async run({ args }) {
    try {
      const serviceHome =
        process.env.SWF_SERVICE_HOME ??
        process.env.SWF_CONFIG_HOME ??
        join(process.env.HOME ?? process.cwd(), ".config", "swf");
      const scopes = (args.scope ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean) as CleanupScope[];
      const unknown = scopes.filter((scope) => !CLEANUP_SCOPES.includes(scope));
      if (unknown.length)
        throw new Error(
          `Unknown cleanup scope(s): ${unknown.join(", ")}. Supported: ${CLEANUP_SCOPES.join(", ")}`,
        );
      if (!scopes.length)
        throw new Error(
          `Select at least one scope with --scope. Supported: ${CLEANUP_SCOPES.join(", ")}`,
        );

      const preview = await previewCleanup({
        serviceHome,
        scopes,
        selectedProjectStateDirectories: (args.project ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });

      if (!args.apply) {
        // Persist so the printed confirmation id binds this exact candidate
        // list; recomputing at apply time could silently widen the plan.
        await persistCleanupPreview(serviceHome, preview);
        if (args.json) return output(preview, true);
        consola.log(renderCleanupPreview(preview));
        return;
      }
      if (!args.confirm)
        throw new Error(
          "Refusing destructive cleanup without --confirm <id> from a preview.",
        );
      const reviewed = await loadCleanupPreview(serviceHome, args.confirm);
      if (!reviewed)
        throw new Error(
          "No reviewed preview matches that confirmation id. Run the preview again.",
        );
      const result = await applyCleanup({
        preview: reviewed,
        confirmationId: args.confirm,
        confirmed: true,
      });
      await discardCleanupPreview(serviceHome, args.confirm);
      if (args.json) return output(result, true);
      for (const path of result.removed) consola.success(`Removed ${path}`);
      for (const entry of result.skipped)
        consola.info(`Skipped ${entry.path}: ${entry.reason}`);
    } catch (error) {
      fail(error, args.json);
    }
  },
});

const main = defineCommand({
  meta: {
    name: "swf",
    version: productVersionLabel(productMetadata),
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
    dashboard,
    upgrade,
    cleanup,
  },
});
await runMain(main);
