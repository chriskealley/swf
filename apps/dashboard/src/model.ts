import type {
  CostSummary,
  Invocation,
  OperatorProjection,
  ServiceEvent,
} from "./types.js";

export function normalizedHarnessProgress(
  event: ServiceEvent,
): string | undefined {
  if (event.type !== "harness.progress") return undefined;
  const normalized =
    event.data.event && typeof event.data.event === "object"
      ? (event.data.event as {
          type?: unknown;
          harness?: unknown;
          phaseId?: unknown;
        })
      : undefined;
  if (!normalized || typeof normalized.type !== "string") return undefined;
  const phase =
    typeof normalized.phaseId === "string" ? ` · ${normalized.phaseId}` : "";
  const harness =
    typeof normalized.harness === "string" ? ` · ${normalized.harness}` : "";
  return `${normalized.type}${phase}${harness}`;
}

export function dashboardGuidanceIdentity(projection: OperatorProjection) {
  return {
    stoppingPhaseId: projection.stoppingPhaseId,
    attentionTypes: projection.attention.map(({ type }) => type),
    actionTypes: projection.allowedActions.map(({ type }) => type),
  };
}

export const activeStatuses = new Set([
  "pending",
  "running",
  "blocked",
  "paused",
]);

export function emptyCosts(): CostSummary {
  return { exactUsd: 0, estimatedUsd: 0, unknown: 0 };
}

export function aggregateCosts(invocations: Invocation[]): CostSummary {
  return invocations.reduce((summary, invocation) => {
    const amount = invocation.cost.amountUsd;
    if (invocation.cost.quality === "unknown" || amount === undefined)
      summary.unknown += 1;
    else if (invocation.cost.quality === "estimated")
      summary.estimatedUsd += amount;
    else summary.exactUsd += amount;
    return summary;
  }, emptyCosts());
}

export function formatInvocationCost(invocation: Invocation): string {
  if (
    invocation.cost.quality === "unknown" ||
    invocation.cost.amountUsd === undefined
  )
    return "Unknown";
  return `${invocation.cost.quality === "estimated" ? "Estimated " : "Exact "}$${invocation.cost.amountUsd.toFixed(4)}`;
}

export function formatAggregateCosts(costs: CostSummary): string[] {
  const values: string[] = [];
  if (costs.exactUsd > 0) values.push(`Exact $${costs.exactUsd.toFixed(2)}`);
  if (costs.estimatedUsd > 0)
    values.push(`Estimated $${costs.estimatedUsd.toFixed(2)}`);
  if (costs.unknown > 0) values.push(`${costs.unknown} unknown`);
  return values.length ? values : ["No recorded spend"];
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
