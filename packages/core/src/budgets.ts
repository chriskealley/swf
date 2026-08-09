export interface BudgetLimit {
  maxCostUsd?: number;
  maxTokens?: number;
  strictUnknown?: boolean;
}

export interface BudgetConfiguration {
  invocation?: BudgetLimit;
  phase?: BudgetLimit;
  phases?: Record<string, BudgetLimit>;
  run?: BudgetLimit;
  project?: BudgetLimit;
  service?: BudgetLimit;
}

export interface BudgetUsage {
  invocationId: string;
  projectId: string;
  runId: string;
  phaseId: string;
  costUsd?: number;
  costQuality: "exact" | "estimated" | "unknown";
  tokens?: number;
}

export type BudgetScope =
  "invocation" | "phase" | "run" | "project" | "service";

export interface BudgetDecision {
  scope: BudgetScope;
  scopeId: string;
  status: "available" | "exhausted" | "indeterminate";
  allowed: boolean;
  consumed: { costUsd: number; tokens: number };
  limits: BudgetLimit;
  unknownCostRecords: number;
  unknownTokenRecords: number;
  reasons: string[];
}

export interface BudgetTarget {
  projectId: string;
  runId: string;
  phaseId?: string;
  invocationId?: string;
}

function decision(
  scope: BudgetScope,
  scopeId: string,
  limits: BudgetLimit,
  records: BudgetUsage[],
): BudgetDecision {
  const consumed = records.reduce(
    (total, record) => ({
      costUsd:
        total.costUsd +
        (record.costQuality === "unknown" ? 0 : (record.costUsd ?? 0)),
      tokens: total.tokens + (record.tokens ?? 0),
    }),
    { costUsd: 0, tokens: 0 },
  );
  const unknownCostRecords = records.filter(
    (record) =>
      record.costQuality === "unknown" || record.costUsd === undefined,
  ).length;
  const unknownTokenRecords = records.filter(
    (record) => record.tokens === undefined,
  ).length;
  const reasons: string[] = [];
  if (limits.maxCostUsd !== undefined && consumed.costUsd >= limits.maxCostUsd)
    reasons.push(
      `cost ${consumed.costUsd.toFixed(6)} USD reached ${limits.maxCostUsd.toFixed(6)} USD`,
    );
  if (limits.maxTokens !== undefined && consumed.tokens >= limits.maxTokens)
    reasons.push(`tokens ${consumed.tokens} reached ${limits.maxTokens}`);
  const indeterminate =
    limits.strictUnknown !== false &&
    ((limits.maxCostUsd !== undefined && unknownCostRecords > 0) ||
      (limits.maxTokens !== undefined && unknownTokenRecords > 0));
  const status = reasons.length
    ? "exhausted"
    : indeterminate
      ? "indeterminate"
      : "available";
  if (indeterminate && !reasons.length)
    reasons.push("usage telemetry is unknown and the budget fails closed");
  return {
    scope,
    scopeId,
    status,
    allowed: status === "available",
    consumed,
    limits,
    unknownCostRecords,
    unknownTokenRecords,
    reasons,
  };
}

export function evaluateBudgets(
  configuration: BudgetConfiguration,
  usage: BudgetUsage[],
  target: BudgetTarget,
): BudgetDecision[] {
  const evaluations: Array<{
    scope: BudgetScope;
    scopeId: string;
    limits?: BudgetLimit;
    records: BudgetUsage[];
  }> = [
    {
      scope: "service",
      scopeId: "service",
      limits: configuration.service,
      records: usage,
    },
    {
      scope: "project",
      scopeId: target.projectId,
      limits: configuration.project,
      records: usage.filter((record) => record.projectId === target.projectId),
    },
    {
      scope: "run",
      scopeId: target.runId,
      limits: configuration.run,
      records: usage.filter((record) => record.runId === target.runId),
    },
  ];
  if (target.phaseId)
    evaluations.push({
      scope: "phase",
      scopeId: target.phaseId,
      limits: configuration.phases?.[target.phaseId] ?? configuration.phase,
      records: usage.filter(
        (record) =>
          record.runId === target.runId && record.phaseId === target.phaseId,
      ),
    });
  if (target.invocationId)
    evaluations.push({
      scope: "invocation",
      scopeId: target.invocationId,
      limits: configuration.invocation,
      records: usage.filter(
        (record) => record.invocationId === target.invocationId,
      ),
    });
  return evaluations.flatMap((evaluation) =>
    evaluation.limits &&
    (evaluation.limits.maxCostUsd !== undefined ||
      evaluation.limits.maxTokens !== undefined)
      ? [
          decision(
            evaluation.scope,
            evaluation.scopeId,
            evaluation.limits,
            evaluation.records,
          ),
        ]
      : [],
  );
}

export function assertBudgetsAvailable(decisions: BudgetDecision[]): void {
  const blocked = decisions.filter((entry) => !entry.allowed);
  if (blocked.length)
    throw new Error(
      `Budget prevents execution: ${blocked
        .map(
          (entry) =>
            `${entry.scope} ${entry.scopeId}: ${entry.reasons.join(", ")}`,
        )
        .join("; ")}`,
    );
}
