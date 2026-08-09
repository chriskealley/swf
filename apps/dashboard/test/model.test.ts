import { describe, expect, it } from "vitest";
import {
  aggregateCosts,
  formatAggregateCosts,
  formatInvocationCost,
} from "../src/model.js";
import type { Invocation } from "../src/types.js";

function invocation(
  quality: "exact" | "estimated" | "unknown",
  amountUsd?: number,
): Invocation {
  return {
    schemaVersion: 1,
    invocationId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    phaseId: "planning",
    harness: "pi",
    status: "completed",
    startedAt: "2026-04-02T12:00:00.000Z",
    cost: { quality, amountUsd },
  };
}

describe("dashboard cost provenance", () => {
  it("keeps exact, estimated, and unknown values distinct at every aggregate", () => {
    const calls = [
      invocation("exact", 1),
      invocation("estimated", 2),
      invocation("unknown"),
    ];
    expect(aggregateCosts(calls)).toEqual({
      exactUsd: 1,
      estimatedUsd: 2,
      unknown: 1,
    });
    expect(formatAggregateCosts(aggregateCosts(calls))).toEqual([
      "Exact $1.00",
      "Estimated $2.00",
      "1 unknown",
    ]);
    expect(formatInvocationCost(calls[2]!)).toBe("Unknown");
  });
});
