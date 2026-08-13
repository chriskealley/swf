import { describe, expect, it } from "vitest";
import {
  buildOperatorProjection,
  classifyOperatorError,
  createRunState,
  OperatorProjectionSchema,
  type Run,
} from "../packages/core/src/index.ts";
import {
  AmbiguousOperatorContextError,
  resolveUniqueAction,
} from "../apps/cli/src/operator-context.ts";
import { renderOperatorProjection } from "../apps/cli/src/operator-renderer.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-13T00:00:00.000Z";

function state(status: Run["status"]) {
  return createRunState({
    schemaVersion: 1,
    projectId,
    runId,
    changeName: "operator-acceptance",
    workflowId: "default",
    description: "Operator failure acceptance",
    phaseIds: ["planning"],
    status,
    createdAt: now,
    updatedAt: now,
  });
}

const workflow = {
  phases: [{ id: "planning", gate: { mode: "manual" } }],
};

describe("operator guidance acceptance", () => {
  it("guides blocked input, failed work, failed checks, dependency, and recoverable infrastructure", () => {
    const value = state("failed");
    value.phases.planning!.status = "failed";
    value.phases.planning!.checks.test = {
      id: "test",
      phaseId: "planning",
      status: "failed",
      updatedAt: now,
      reason: "three tests failed",
    };
    value.invocations["33333333-3333-4333-8333-333333333333"] = {
      schemaVersion: 1,
      invocationId: "33333333-3333-4333-8333-333333333333",
      runId,
      phaseId: "planning",
      harness: "pi",
      status: "blocked",
      startedAt: now,
      cost: { quality: "unknown" },
    };
    const projection = buildOperatorProjection({
      state: value,
      workflow,
      failures: [
        {
          category: "work",
          code: "WORK_INVALID",
          message: "Required artifact is missing",
          phaseId: "planning",
          retryable: true,
        },
        {
          category: "dependency",
          code: "DEPENDENCY_UNAVAILABLE",
          message: "OpenSpec is unavailable",
          phaseId: "planning",
          retryable: false,
        },
        {
          category: "infrastructure",
          code: "HERDR_CONTROL_FAILED",
          message: "Herdr control failed before work started",
          phaseId: "planning",
          retryable: true,
        },
      ],
    });
    expect(projection.attention.map(({ type }) => type)).toEqual([
      "failed-check",
      "blocked-input",
      "work-failure",
      "dependency-failure",
      "infrastructure-failure",
    ]);
    const rendered = renderOperatorProjection(projection);
    expect(rendered).toContain("retryable");
    expect(rendered).toContain("OpenSpec is unavailable");
  });

  it("refuses ambiguous shorthand and preserves explicit-ID/versioned automation", () => {
    const value = state("blocked");
    value.phases.planning!.status = "blocked";
    const projection = buildOperatorProjection({ state: value, workflow });
    const duplicate = {
      actionId: "retry:two",
      type: "retry" as const,
      label: "Retry another attempt",
      parameters: {
        projectId,
        runId,
        changeName: "operator-acceptance",
        phaseId: "planning",
      },
      requiresConfirmation: false,
      recommended: false,
    };
    const ambiguous = {
      ...projection,
      allowedActions: [
        {
          ...duplicate,
          actionId: "retry:one",
          label: "Retry attempt",
        },
        duplicate,
      ],
    };
    expect(() => resolveUniqueAction(ambiguous, ["retry"])).toThrow(
      AmbiguousOperatorContextError,
    );
    expect(OperatorProjectionSchema.parse(projection).schemaVersion).toBe(1);
    expect(classifyOperatorError({ error: new Error("budget exhausted") })).toMatchObject({
      schemaVersion: 1,
      category: "budget",
    });
    expect(duplicate.parameters).toMatchObject({ projectId, runId, phaseId: "planning" });
  });
});
