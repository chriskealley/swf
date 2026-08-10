import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface RunSummary {
  runId?: string;
  status?: string;
  phases?: Record<
    string,
    {
      status?: string;
      gate?: { status?: string };
      checks?: Record<string, unknown>;
    }
  >;
  costs?: { exactUsd?: number; estimatedUsd?: number; unknown?: number };
}

interface SwfServiceClient {
  query<T>(
    resource: string,
    input?: { projectId?: string; runId?: string },
  ): Promise<T>;
  command(command: Record<string, unknown>): Promise<void>;
}

async function withClient<T>(
  operation: (client: SwfServiceClient) => Promise<T>,
): Promise<T> {
  const home =
    process.env.SWF_SERVICE_HOME ??
    process.env.SWF_CONFIG_HOME ??
    join(process.env.HOME ?? process.cwd(), ".config", "swf");
  const metadata = JSON.parse(
    await readFile(join(home, "service.json"), "utf8"),
  ) as { endpoint: string; credential: string };
  const request = async <R>(
    path: string,
    init: RequestInit = {},
  ): Promise<R> => {
    const response = await fetch(`${metadata.endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${metadata.credential}`,
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json()) as {
      result?: R;
      statusMessage?: string;
    };
    if (!response.ok)
      throw new Error(
        body.statusMessage ?? `SWF service returned HTTP ${response.status}`,
      );
    return body.result as R;
  };
  return operation({
    query: <R>(
      resource: string,
      input: { projectId?: string; runId?: string } = {},
    ) => {
      const query = new URLSearchParams({ resource });
      if (input.projectId) query.set("projectId", input.projectId);
      if (input.runId) query.set("runId", input.runId);
      return request<R>(`/api/v1/query?${query}`);
    },
    command: (command) =>
      request<unknown>("/api/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }).then(() => undefined),
  });
}

const enumSchema = (values: string[]) => ({ type: "string", enum: values });
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required });

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export default function (pi: ExtensionAPI) {
  let current: RunSummary | undefined;

  const refresh = async (ctx: {
    ui: {
      setStatus(key: string, value?: string): void;
      setWidget(key: string, value?: string[]): void;
    };
  }) => {
    try {
      const projects = await withClient((service) =>
        service.query<Array<{ projectId: string }>>("projects"),
      );
      const project = projects[0];
      if (!project) {
        ctx.ui.setStatus("swf", "SWF: no registered projects");
        return;
      }
      const runs = await withClient((service) =>
        service.query<Array<RunSummary>>("runs", {
          projectId: project.projectId,
        }),
      );
      const summary = runs[0];
      if (summary?.runId) {
        const loaded = await withClient((service) =>
          service.query<{
            state: { run: RunSummary; phases: RunSummary["phases"] };
          }>("run", { projectId: project.projectId, runId: summary.runId }),
        );
        current = {
          ...loaded.state.run,
          phases: loaded.state.phases,
          costs: await withClient((service) =>
            service.query("costs", {
              projectId: project.projectId,
              runId: summary.runId,
            }),
          ),
        };
      } else current = undefined;
      const phase =
        current?.phases &&
        Object.entries(current.phases).find(
          ([, value]) =>
            value.status === "running" || value.status === "blocked",
        );
      const checks = current?.phases
        ? Object.values(current.phases).reduce(
            (count, item) => count + Object.keys(item.checks ?? {}).length,
            0,
          )
        : 0;
      const spend = current?.costs
        ? ` · $${((current.costs.exactUsd ?? 0) + (current.costs.estimatedUsd ?? 0)).toFixed(2)}${current.costs.unknown ? " +unknown" : ""}`
        : "";
      const label = current
        ? `SWF ${current.status ?? "unknown"}${phase ? ` · ${phase[0]} ${phase[1].status}` : ""} · ${checks} checks${spend}`
        : "SWF: no runs";
      ctx.ui.setStatus("swf", label);
      ctx.ui.setWidget("swf", [label]);
    } catch {
      ctx.ui.setStatus("swf", "SWF: service unavailable");
      ctx.ui.setWidget("swf", undefined);
    }
  };

  pi.registerTool({
    name: "swf_query",
    label: "SWF Query",
    description:
      "Query durable SWF service state for runs, phases, artifacts, output, costs, and configuration.",
    promptSnippet: "Query durable SWF service state",
    promptGuidelines: [
      "Use swf_query to inspect SWF state instead of reading or mutating .swf-state directly.",
    ],
    parameters: objectSchema(
      {
        resource: enumSchema([
          "projects",
          "adapters",
          "runs",
          "run",
          "phases",
          "invocations",
          "artifacts",
          "costs",
          "budgets",
          "operations",
          "configuration",
          "delivery",
          "blocked-inputs",
          "model-routes",
          "phase-explanation",
          "check-discovery",
          "defaults",
        ]),
        projectId: { type: "string" },
        runId: { type: "string" },
      },
      ["resource"],
    ) as never,
    renderCall(args, theme) {
      return {
        render: () => [
          theme.fg(
            "toolTitle",
            `swf query ${(args as { resource: string }).resource}`,
          ),
        ],
        invalidate() {},
      };
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as unknown;
      return {
        render: () => [
          theme.fg("success", "✓ SWF query"),
          ...(expanded
            ? [theme.fg("dim", JSON.stringify(details, null, 2))]
            : []),
        ],
        invalidate() {},
      };
    },
    async execute(
      _id,
      params: { resource: string; projectId?: string; runId?: string },
    ) {
      return text(
        await withClient((service) =>
          service.query(params.resource, {
            projectId: params.projectId,
            runId: params.runId,
          }),
        ),
      );
    },
  });

  pi.registerTool({
    name: "swf_command",
    label: "SWF Command",
    description:
      "Submit an operator-authorized SWF lifecycle, gate, rollback, or blocked-input command through the service.",
    promptSnippet: "Submit an authorized SWF operator command",
    promptGuidelines: [
      "Use swf_command for SWF lifecycle changes; never edit active SWF state files directly.",
    ],
    parameters: objectSchema(
      {
        action: enumSchema([
          "start",
          "pause",
          "resume",
          "cancel",
          "approve",
          "reject",
          "request-changes",
          "remediate",
          "rollback",
          "blocked-input",
          "deliver",
          "refresh-delivery",
          "reconcile",
          "migrate",
          "export-run",
          "import-run",
          "archive-change",
          "model-map-preview",
          "model-map-apply",
          "checks-preview",
          "checks-apply",
          "defaults-adopt",
        ]),
        projectId: { type: "string" },
        runId: { type: "string" },
        phaseId: { type: "string" },
        gateId: { type: "string" },
        checkpointId: { type: "string" },
        reason: { type: "string" },
        actorId: { type: "string" },
        invocationId: { type: "string" },
        response: { type: "string" },
        path: { type: "string" },
        apply: { type: "boolean" },
        dryRun: { type: "boolean" },
        target: { type: "number" },
        rollbackBackupId: { type: "string" },
        authorized: { type: "boolean" },
      },
      ["action"],
    ) as never,
    renderCall(args, theme) {
      return {
        render: () => [
          theme.fg(
            "toolTitle",
            `swf command ${(args as { action: string }).action}`,
          ),
        ],
        invalidate() {},
      };
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as unknown;
      return {
        render: () => [
          theme.fg("success", "✓ SWF command accepted"),
          ...(expanded
            ? [theme.fg("dim", JSON.stringify(details, null, 2))]
            : []),
        ],
        invalidate() {},
      };
    },
    async execute(
      _id,
      params: {
        action: string;
        projectId?: string;
        runId?: string;
        phaseId?: string;
        gateId?: string;
        checkpointId?: string;
        reason?: string;
        actorId?: string;
        invocationId?: string;
        response?: string;
        path?: string;
        apply?: boolean;
        dryRun?: boolean;
        target?: number;
        rollbackBackupId?: string;
        authorized?: boolean;
      },
      _signal,
      _update,
      ctx,
    ) {
      await withClient((service) =>
        service.command({
          type: params.action,
          projectId: params.projectId,
          runId: params.runId,
          phaseId: params.phaseId,
          gateId: params.gateId,
          checkpointId: params.checkpointId,
          reason: params.reason,
          actorId: params.actorId ?? "pi-operator",
          invocationId: params.invocationId,
          response: params.response,
          path: params.path,
          apply: params.apply,
          dryRun: params.dryRun,
          target: params.target,
          rollbackBackupId: params.rollbackBackupId,
          authorized: params.authorized,
        }),
      );
      await refresh(ctx);
      return text({ accepted: true, action: params.action });
    },
  });

  pi.registerCommand("swf-status", {
    description: "Refresh and display current SWF status",
    handler: async (_args, ctx) => {
      await refresh(ctx);
      ctx.ui.notify("SWF status refreshed", "info");
    },
  });
  pi.registerCommand("swf-approve", {
    description: "Approve a gate through the SWF service",
    handler: async (args, ctx) => {
      const [projectId, runId, phaseId, gateId] = args.split(/\s+/);
      if (!projectId || !runId || !phaseId || !gateId) {
        ctx.ui.notify(
          "Usage: /swf-approve <project> <run> <phase> <gate>",
          "warning",
        );
        return;
      }
      if (
        ctx.hasUI &&
        !(await ctx.ui.confirm("Approve SWF gate?", `${phaseId}/${gateId}`))
      )
        return;
      await withClient((service) =>
        service.command({
          type: "approve",
          projectId,
          runId,
          phaseId,
          gateId,
          actorId: "pi-operator",
        }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-reject", {
    description: "Reject a gate through the SWF service",
    handler: async (args, ctx) => {
      const [projectId, runId, phaseId, gateId] = args.split(/\s+/);
      if (!projectId || !runId || !phaseId || !gateId) {
        ctx.ui.notify(
          "Usage: /swf-reject <project> <run> <phase> <gate>",
          "warning",
        );
        return;
      }
      const reason = ctx.hasUI
        ? await ctx.ui.input("Reason", "Explain required changes")
        : undefined;
      await withClient((service) =>
        service.command({
          type: "reject",
          projectId,
          runId,
          phaseId,
          gateId,
          actorId: "pi-operator",
          reason,
        }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-request-changes", {
    description: "Request changes for a gate through the SWF service",
    handler: async (args, ctx) => {
      const [projectId, runId, phaseId, gateId] = args.split(/\s+/);
      if (!projectId || !runId || !phaseId || !gateId) {
        ctx.ui.notify(
          "Usage: /swf-request-changes <project> <run> <phase> <gate>",
          "warning",
        );
        return;
      }
      const reason = ctx.hasUI
        ? await ctx.ui.input("Requested changes", "Explain required changes")
        : undefined;
      if (!reason) return;
      await withClient((service) =>
        service.command({
          type: "request-changes",
          projectId,
          runId,
          phaseId,
          gateId,
          actorId: "pi-operator",
          reason,
        }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-input", {
    description: "Reply to a blocked SWF agent",
    handler: async (args, ctx) => {
      const [invocationId, ...reply] = args.split(/\s+/);
      if (!invocationId) {
        ctx.ui.notify("Usage: /swf-input <invocation> <reply>", "warning");
        return;
      }
      const response =
        reply.join(" ") ||
        (ctx.hasUI ? await ctx.ui.input("Agent input", "Response") : undefined);
      if (!response) return;
      await withClient((service) =>
        service.command({ type: "blocked-input", invocationId, response }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-pause", {
    description: "Pause a SWF run",
    handler: async (args, ctx) => {
      const [projectId, runId] = args.split(/\s+/);
      if (!projectId || !runId)
        return ctx.ui.notify("Usage: /swf-pause <project> <run>", "warning");
      await withClient((service) =>
        service.command({ type: "pause", projectId, runId }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-resume", {
    description: "Resume a SWF run",
    handler: async (args, ctx) => {
      const [projectId, runId] = args.split(/\s+/);
      if (!projectId || !runId)
        return ctx.ui.notify("Usage: /swf-resume <project> <run>", "warning");
      await withClient((service) =>
        service.command({ type: "resume", projectId, runId }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-rollback", {
    description: "Roll back a SWF run to a checkpoint",
    handler: async (args, ctx) => {
      const [projectId, runId, phaseId, checkpointId] = args.split(/\s+/);
      if (!projectId || !runId || !phaseId || !checkpointId)
        return ctx.ui.notify(
          "Usage: /swf-rollback <project> <run> <phase> <checkpoint>",
          "warning",
        );
      if (
        ctx.hasUI &&
        !(await ctx.ui.confirm("Roll back SWF run?", checkpointId))
      )
        return;
      await withClient((service) =>
        service.command({
          type: "rollback",
          projectId,
          runId,
          phaseId,
          checkpointId,
          authorized: true,
        }),
      );
      await refresh(ctx);
    },
  });
  pi.registerCommand("swf-cancel", {
    description: "Cancel a SWF run",
    handler: async (args, ctx) => {
      const [projectId, runId] = args.split(/\s+/);
      if (!projectId || !runId)
        return ctx.ui.notify("Usage: /swf-cancel <project> <run>", "warning");
      if (ctx.hasUI && !(await ctx.ui.confirm("Cancel SWF run?", runId)))
        return;
      await withClient((service) =>
        service.command({ type: "cancel", projectId, runId }),
      );
      await refresh(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("swf", undefined);
    ctx.ui.setWidget("swf", undefined);
  });
}
