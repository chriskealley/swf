import type { CostSummary, Invocation } from "./types.js";

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
