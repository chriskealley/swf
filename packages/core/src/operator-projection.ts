import { createHash } from "node:crypto";
import { z } from "zod";
import type { BudgetDecision } from "./budgets.js";
import type { RunState } from "./domain.js";
import {
  ClassifiedOperatorErrorSchema,
  OperatorActionSchema,
  OperatorAttentionSchema,
  OperatorProjectionSchema,
  type CheckStatusSchema,
} from "./schemas.js";

export type OperatorProjection = z.infer<typeof OperatorProjectionSchema>;
export type OperatorAction = z.infer<typeof OperatorActionSchema>;
export type OperatorAttention = z.infer<typeof OperatorAttentionSchema>;
export type ClassifiedOperatorError = z.infer<
  typeof ClassifiedOperatorErrorSchema
>;
export type OperatorFailureCategory = ClassifiedOperatorError["category"];

export interface ProjectionWorkflow {
  phases: Array<{ id: string; title?: string; gate?: { mode: string } }>;
}

export interface ProjectionFailure {
  category: OperatorFailureCategory;
  code: string;
  message: string;
  phaseId?: string;
  retryable?: boolean;
  diagnosticRefs?: string[];
}

export interface OperatorProjectionInput {
  state: RunState;
  workflow: ProjectionWorkflow;
  budgets?: readonly BudgetDecision[];
  failures?: readonly ProjectionFailure[];
}

type CheckStatus = z.infer<typeof CheckStatusSchema>;

function stableId(prefix: string, parts: Array<string | undefined>): string {
  const digest = createHash("sha256")
    .update(parts.filter(Boolean).join("\0"))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}:${digest}`;
}

function action(
  state: RunState,
  type: OperatorAction["type"],
  label: string,
  parameters: Partial<OperatorAction["parameters"]> = {},
  options: { recommended?: boolean; requiresConfirmation?: boolean } = {},
): OperatorAction {
  const complete = {
    projectId: state.run.projectId,
    runId: state.run.runId,
    changeName: state.run.changeName,
    ...parameters,
  };
  return OperatorActionSchema.parse({
    actionId: stableId(type, [
      state.run.runId,
      complete.phaseId,
      complete.gateId,
      complete.invocationId,
      complete.deliveryId,
    ]),
    type,
    label,
    parameters: complete,
    requiresConfirmation: options.requiresConfirmation ?? false,
    recommended: options.recommended ?? false,
  });
}

function latestBy<T>(values: T[], timestamp: (value: T) => string): T | undefined {
  return values.sort((left, right) => timestamp(right).localeCompare(timestamp(left)))[0];
}

function failureAttentionType(
  category: OperatorFailureCategory,
): OperatorAttention["type"] {
  if (category === "configuration") return "configuration-failure";
  if (category === "dependency") return "dependency-failure";
  if (category === "infrastructure") return "infrastructure-failure";
  if (category === "harness") return "harness-failure";
  if (category === "work") return "work-failure";
  if (category === "policy") return "policy-failure";
  if (category === "delivery") return "delivery-failure";
  if (category === "check") return "failed-check";
  return category === "budget" ? "budget-block" : "work-failure";
}

export function classifyOperatorError(input: {
  error: unknown;
  category?: OperatorFailureCategory;
  state?: RunState;
  recoveryActions?: OperatorAction[];
  diagnosticRefs?: string[];
}): ClassifiedOperatorError {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const lower = message.toLowerCase();
  const category =
    input.category ??
    (lower.includes("budget")
      ? "budget"
      : lower.includes("harness") || lower.includes("adapter")
        ? "harness"
        : lower.includes("delivery") || lower.includes("merge")
          ? "delivery"
          : lower.includes("config") || lower.includes("initialized")
            ? "configuration"
            : lower.includes("dependency") || lower.includes("unavailable")
              ? "dependency"
                : lower.includes("check") || lower.includes("validation")
                ? "check"
                : lower.includes("policy") ||
                    lower.includes("authorization") ||
                    lower.includes("already") ||
                    lower.includes("not permitted") ||
                    lower.includes("blocked")
                  ? "policy"
                  : "infrastructure");
  const retryable = ["infrastructure", "harness", "dependency"].includes(category);
  return ClassifiedOperatorErrorSchema.parse({
    schemaVersion: 1,
    code: `SWF_${category.toUpperCase().replaceAll("-", "_")}`,
    category,
    message,
    retryable,
    runStatus: input.state?.run.status,
    diagnosticRefs: input.diagnosticRefs ?? [],
    recoveryActions: input.recoveryActions ?? [],
  });
}

export function buildOperatorProjection(
  input: OperatorProjectionInput,
): OperatorProjection {
  const { state, workflow } = input;
  const phaseOrder = workflow.phases.map(({ id }) => id);
  const phases = phaseOrder.map((id) => state.phases[id]).filter(Boolean);
  const active = phases.find((phase) =>
    ["running", "blocked", "failed"].includes(phase!.status),
  );
  const completed = [...phases].reverse().find((phase) => phase!.status === "completed");
  const next = phases.find((phase) => phase!.status === "pending");
  const stoppingPhaseId = active?.id ?? completed?.id;
  const actions: OperatorAction[] = [];
  const attention: OperatorAttention[] = [];
  const artifacts = Object.values(state.artifacts).filter(
    ({ status }) => status !== "missing" && status !== "invalid",
  );
  const checks = phases.flatMap((phase) =>
    Object.values(phase!.checks).map(({ id, status, reason }) => ({ id, status, reason })),
  );
  const checkpoints = Object.values(state.checkpoints);
  const changedPaths = [...new Set(checkpoints.flatMap(({ changedFiles }) => changedFiles))].sort();
  const risks = artifacts
    .filter(({ type }) => type.includes("handoff") || type.includes("review"))
    .flatMap(({ summary }) => (summary ? [summary] : []));
  const evidence = {
    checks: checks as Array<{ id: string; status: CheckStatus; reason?: string }>,
    changedPaths,
    risks,
    artifactIds: artifacts.map(({ artifactId }) => artifactId).sort(),
  };

  for (const phase of phases) {
    if (!phase) continue;
    const gate = phase.gate;
    if (phase.status === "blocked" && gate?.status === "blocked") {
      const phaseActions = [
        action(state, "inspect-evidence", `Review ${phase.id} evidence`, { phaseId: phase.id }),
        action(state, "approve", `Approve ${phase.id}`, { phaseId: phase.id, gateId: gate.id }, { recommended: true, requiresConfirmation: true }),
        action(state, "request-changes", `Request changes for ${phase.id}`, { phaseId: phase.id, gateId: gate.id }, { requiresConfirmation: true }),
        action(state, "reject", `Reject ${phase.id}`, { phaseId: phase.id, gateId: gate.id }, { requiresConfirmation: true }),
      ];
      actions.push(...phaseActions);
      attention.push(OperatorAttentionSchema.parse({
        attentionId: stableId("manual-approval", [state.run.runId, phase.id, gate.id]),
        type: "manual-approval",
        projectId: state.run.projectId,
        runId: state.run.runId,
        changeName: state.run.changeName,
        phaseId: phase.id,
        gateId: gate.id,
        title: `${phase.id} requires approval`,
        reason: gate.reason ?? "The manual phase gate is waiting for an operator decision.",
        retryable: false,
        evidence: {
          ...evidence,
          checks: Object.values(phase.checks).map(({ id, status, reason }) => ({ id, status, reason })),
          artifactIds: artifacts.filter((artifact) => artifact.phaseId === phase.id).map(({ artifactId }) => artifactId).sort(),
        },
        actionIds: phaseActions.map(({ actionId }) => actionId),
      }));
    }
    for (const check of Object.values(phase.checks).filter(({ status }) => status === "failed")) {
      const retry = action(state, "retry", `Retry ${phase.id}`, { phaseId: phase.id }, { recommended: true });
      actions.push(retry);
      attention.push(OperatorAttentionSchema.parse({
        attentionId: stableId("failed-check", [state.run.runId, phase.id, check.id]),
        type: "failed-check",
        projectId: state.run.projectId,
        runId: state.run.runId,
        changeName: state.run.changeName,
        phaseId: phase.id,
        title: `Check ${check.id} failed`,
        reason: check.reason ?? `Required check ${check.id} did not pass.`,
        retryable: true,
        evidence,
        actionIds: [retry.actionId],
      }));
    }
  }

  for (const invocation of Object.values(state.invocations).filter(({ status }) => status === "blocked")) {
    const reply = action(state, "reply-to-invocation", `Reply to ${invocation.phaseId} agent`, { phaseId: invocation.phaseId, invocationId: invocation.invocationId }, { recommended: true });
    actions.push(reply);
    attention.push(OperatorAttentionSchema.parse({
      attentionId: stableId("blocked-input", [state.run.runId, invocation.invocationId]),
      type: "blocked-input",
      projectId: state.run.projectId,
      runId: state.run.runId,
      changeName: state.run.changeName,
      phaseId: invocation.phaseId,
      invocationId: invocation.invocationId,
      title: `${invocation.phaseId} agent needs input`,
      reason: "The active invocation is blocked waiting for operator input.",
      retryable: true,
      actionIds: [reply.actionId],
    }));
  }

  for (const budget of input.budgets ?? []) {
    if (budget.status === "available") continue;
    const configure = action(state, "configure", "Review budget configuration", active ? { phaseId: active.id } : {}, { recommended: true });
    actions.push(configure);
    attention.push(OperatorAttentionSchema.parse({
      attentionId: stableId("budget-block", [state.run.runId, budget.scope, budget.scopeId]),
      type: "budget-block",
      projectId: state.run.projectId,
      runId: state.run.runId,
      changeName: state.run.changeName,
      phaseId: active?.id,
      title: `${budget.scope} budget ${budget.status}`,
      reason: budget.reasons.join("; ") || "Budget policy prevents further work.",
      retryable: false,
      actionIds: [configure.actionId],
    }));
  }

  for (const failure of input.failures ?? []) {
    const recovery = action(
      state,
      failure.retryable === false ? "configure" : failure.category === "infrastructure" ? "reconcile" : "retry",
      failure.retryable === false ? "Review configuration" : "Retry safely",
      failure.phaseId ? { phaseId: failure.phaseId } : {},
      { recommended: true },
    );
    actions.push(recovery);
    attention.push(OperatorAttentionSchema.parse({
      attentionId: stableId(failure.category, [state.run.runId, failure.phaseId, failure.code]),
      type: failureAttentionType(failure.category),
      projectId: state.run.projectId,
      runId: state.run.runId,
      changeName: state.run.changeName,
      phaseId: failure.phaseId,
      title: failure.code,
      reason: failure.message,
      retryable: failure.retryable ?? ["dependency", "infrastructure", "harness"].includes(failure.category),
      actionIds: [recovery.actionId],
    }));
  }

  const delivery = latestBy(Object.values(state.deliveries), ({ updatedAt }) => updatedAt);
  if (delivery?.status === "failed" || delivery?.status === "checks-failed") {
    const retry = action(state, "retry", "Retry delivery", { deliveryId: delivery.deliveryId }, { recommended: true });
    actions.push(retry);
    attention.push(OperatorAttentionSchema.parse({
      attentionId: stableId("delivery-failure", [state.run.runId, delivery.deliveryId]),
      type: "delivery-failure",
      projectId: state.run.projectId,
      runId: state.run.runId,
      changeName: state.run.changeName,
      title: "Delivery needs attention",
      reason: delivery.failureReason ?? `Delivery is ${delivery.status}.`,
      retryable: true,
      actionIds: [retry.actionId],
    }));
  }

  if (!attention.length && state.run.status === "paused" && next) {
    actions.push(
      action(state, "run-phase", `Run ${next.id}`, { phaseId: next.id }, { recommended: true }),
      action(state, "continue-run", "Continue automatically", { phaseId: next.id }),
    );
  } else if (!attention.length && state.run.status === "pending") {
    actions.push(action(state, "continue-run", "Start workflow", next ? { phaseId: next.id } : {}, { recommended: true }));
  } else if (!attention.length && state.run.status === "failed") {
    actions.push(action(state, "retry", "Retry workflow", active ? { phaseId: active.id } : {}, { recommended: true }));
  }

  if (delivery?.status === "local-branch" || delivery?.status === "merged") {
    actions.push(
      action(state, "review-delivery", `Review ${delivery.branch}`, { deliveryId: delivery.deliveryId, branch: delivery.branch, targetBranch: delivery.targetBranch }, { recommended: delivery.status === "local-branch" }),
      ...(delivery.status === "local-branch" ? [action(state, "merge-delivery", `Merge ${delivery.branch}`, { deliveryId: delivery.deliveryId, branch: delivery.branch, targetBranch: delivery.targetBranch }, { requiresConfirmation: true })] : []),
    );
  }

  const uniqueActions = [...new Map(actions.map((item) => [item.actionId, item])).values()];
  const recommended = uniqueActions.find(({ recommended }) => recommended) ?? uniqueActions[0];
  const summary = attention.length
    ? `${state.run.changeName} is ${state.run.status}; ${attention[0]!.title}.`
    : state.run.status === "completed"
      ? `${state.run.changeName} completed${delivery ? ` with ${delivery.status} delivery` : ""}.`
      : state.run.status === "paused" && completed
        ? `${completed.id} completed; ${next ? `${next.id} is next` : "workflow is ready to finish"}.`
        : `${state.run.changeName} is ${state.run.status}${active ? ` in ${active.id}` : ""}.`;

  return OperatorProjectionSchema.parse({
    schemaVersion: 1,
    projectId: state.run.projectId,
    runId: state.run.runId,
    changeName: state.run.changeName,
    workflowId: state.run.workflowId,
    status: state.run.status,
    summary,
    currentPhaseId: active?.id ?? next?.id,
    stoppingPhaseId,
    completedPhaseId: completed?.id,
    nextPhaseId: next?.id,
    attention,
    allowedActions: uniqueActions,
    recommendedActionId: recommended?.actionId,
    evidence,
    delivery: delivery
      ? {
          deliveryId: delivery.deliveryId,
          status: delivery.status,
          branch: delivery.branch,
          targetBranch: delivery.targetBranch,
          dossierRef: delivery.dossierRef,
          checkpointCount: checkpoints.length,
        }
      : undefined,
  });
}
