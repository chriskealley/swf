import { describe, expect, it } from "vitest";
import {
  createSetupPlan,
  validateJsonDocument,
} from "../packages/core/src/index.ts";

describe("foundation workflow", () => {
  it("builds non-mutating setup plans and validates persisted contracts", () => {
    const plan = createSetupPlan(["herdr-integration:pi"]);
    expect(plan.actions).toHaveLength(1);

    expect(
      validateJsonDocument("policy", {
        schemaVersion: 1,
        id: "manual",
        approvalMode: "manual",
        maxAttempts: 1,
        riskOverrides: [],
      }).valid,
    ).toBe(true);
  });
});
