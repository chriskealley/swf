import { describe, expect, it } from "vitest";
import {
  OperatorProjectionSchema,
  actionCommandType,
  buildOperatorProjection,
  classifyOperatorError,
  createRunEvent,
  createRunState,
  reconstructRunState,
  type Run,
  type RunState,
} from "../src/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const invocationId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const deliveryId = "55555555-5555-4555-8555-555555555555";
const now = "2026-08-13T00:00:00.000Z";
const workflow = {
  phases: [
    { id: "planning", title: "Planning", gate: { mode: "manual" } },
    { id: "building", title: "Building", gate: { mode: "automatic" } },
  ],
};

function run(status: Run["status"]): Run {
  return {
    schemaVersion: 1,
    runId,
    projectId,
    changeName: "operator-test",
    workflowId: "default",
    phaseIds: ["planning", "building"],
    description: "Exercise operator projections",
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function state(status: Run["status"]): RunState {
  return createRunState(run(status));
}

function projection(value: RunState, extras: Record<string, unknown> = {}) {
  return buildOperatorProjection({ state: value, workflow, ...extras });
}

describe("operator projections", () => {
  it.each([
    ["pending", "Start workflow"],
    ["running", undefined],
    ["paused", "Run planning"],
    ["blocked", undefined],
    ["failed", "Retry workflow"],
    ["cancelled", undefined],
    ["completed", undefined],
  ] as const)("covers the %s run state", (status, actionLabel) => {
    const value = state(status);
    if (status === "running") value.phases.planning!.status = "running";
    if (status === "blocked") value.phases.planning!.status = "blocked";
    const result = projection(value);
    expect(OperatorProjectionSchema.parse(result).status).toBe(status);
    if (actionLabel)
      expect(result.allowedActions.map(({ label }) => label)).toContain(
        actionLabel,
      );
  });

  it("projects manual approval with evidence and semantic decisions", () => {
    const value = state("blocked");
    value.phases.planning = {
      ...value.phases.planning!,
      status: "blocked",
      checks: {
        openspec: {
          id: "openspec",
          phaseId: "planning",
          status: "passed",
          updatedAt: now,
          artifactId,
        },
      },
      gate: {
        id: "planning-gate",
        phaseId: "planning",
        status: "blocked",
        decidedAt: now,
        reason: "Manual review required",
      },
    };
    value.artifacts[artifactId] = {
      schemaVersion: 1,
      artifactId,
      runId,
      phaseId: "planning",
      type: "phase-handoff",
      sourceCommit: "abc",
      inputFingerprint: "input",
      status: "valid",
      createdAt: now,
      outputRef: "artifacts/handoff.json",
      summary: "Risk: migration needs review",
      consumers: [],
    };
    const result = projection(value);
    expect(result.attention[0]).toMatchObject({
      type: "manual-approval",
      phaseId: "planning",
      gateId: "planning-gate",
    });
    expect(result.allowedActions.map(({ type }) => type)).toEqual([
      "inspect-evidence",
      "approve",
      "request-changes",
      "reject",
    ]);
    expect(JSON.stringify(result)).not.toContain("transcript");
  });

  it("projects blocked input, failed checks, and budget blocks", () => {
    const value = state("blocked");
    value.phases.planning!.status = "blocked";
    value.phases.planning!.checks.lint = {
      id: "lint",
      phaseId: "planning",
      status: "failed",
      updatedAt: now,
      reason: "lint failed",
    };
    value.invocations[invocationId] = {
      schemaVersion: 1,
      invocationId,
      runId,
      phaseId: "planning",
      harness: "pi",
      status: "blocked",
      startedAt: now,
      cost: { quality: "unknown" },
    };
    const result = projection(value, {
      budgets: [
        {
          scope: "run",
          scopeId: runId,
          status: "exhausted",
          allowed: false,
          consumed: { costUsd: 5, tokens: 10 },
          limits: { maxCostUsd: 5 },
          unknownCostRecords: 0,
          unknownTokenRecords: 0,
          reasons: ["cost reached limit"],
        },
      ],
    });
    expect(result.attention.map(({ type }) => type).sort()).toEqual([
      "blocked-input",
      "budget-block",
      "failed-check",
    ]);
  });

  it.each([
    "configuration",
    "dependency",
    "infrastructure",
    "harness",
    "work",
    "policy",
  ] as const)("projects a %s failure", (category) => {
    const result = projection(state("failed"), {
      failures: [
        {
          category,
          code: `${category}-failure`,
          message: `${category} unavailable`,
          phaseId: "planning",
        },
      ],
    });
    expect(result.attention[0]?.type).toBe(`${category}-failure`);
    expect(result.allowedActions).toHaveLength(1);
  });

  it("projects completed local delivery with review and merge actions", () => {
    const value = state("completed");
    value.phases.planning!.status = "completed";
    value.phases.building!.status = "completed";
    value.deliveries[deliveryId] = {
      schemaVersion: 1,
      deliveryId,
      runId,
      provider: "local",
      mode: "local-branch",
      executionStatus: "completed",
      status: "local-branch",
      remote: "origin",
      branch: "swf/operator-test",
      targetBranch: "main",
      mergeMethod: "merge",
      autoMergeRequested: false,
      hostedChecks: [],
      reviews: [],
      dossierRef: "dossier.json",
      updatedAt: now,
    };
    const result = projection(value);
    expect(result.delivery).toMatchObject({
      branch: "swf/operator-test",
      targetBranch: "main",
      dossierRef: "dossier.json",
    });
    expect(result.allowedActions.map(({ type }) => type)).toEqual([
      "review-delivery",
      "merge-delivery",
    ]);
  });

  it("maps semantic action types to service command types", () => {
    const value = state("failed");
    value.deliveries[deliveryId] = {
      schemaVersion: 1,
      deliveryId,
      runId,
      provider: "local",
      mode: "local-branch",
      executionStatus: "failed",
      status: "failed",
      remote: "origin",
      branch: "swf/operator-test",
      targetBranch: "main",
      mergeMethod: "merge",
      autoMergeRequested: false,
      hostedChecks: [],
      reviews: [],
      failureReason: "push rejected",
      updatedAt: now,
    };
    const deliveryRetry = projection(value).allowedActions.find(
      ({ type, parameters }) => type === "retry" && parameters.deliveryId,
    );
    const workflowRetry = projection(state("failed")).allowedActions.find(
      ({ type, parameters }) => type === "retry" && !parameters.deliveryId,
    );
    expect(actionCommandType(deliveryRetry!)).toBe("refresh-delivery");
    expect(actionCommandType(workflowRetry!)).toBe("run");
    expect(
      actionCommandType({ ...deliveryRetry!, type: "review-delivery" }),
    ).toBeUndefined();
    expect(
      actionCommandType({ ...deliveryRetry!, type: "reply-to-invocation" }),
    ).toBe("blocked-input");
    expect(actionCommandType({ ...deliveryRetry!, type: "run-phase" })).toBe(
      "next",
    );
    expect(actionCommandType({ ...deliveryRetry!, type: "continue-run" })).toBe(
      "run",
    );
    expect(actionCommandType({ ...deliveryRetry!, type: "approve" })).toBe(
      "approve",
    );
  });

  it("rebuilds an identical projection from authoritative events", () => {
    const base = run("pending");
    const events = [
      createRunEvent({
        runId,
        sequence: 0,
        timestamp: now,
        type: "run.created",
        actor: { type: "service", id: "test" },
        context: {},
        data: { changeIdentity: "operator-test" },
      }),
    ];
    const first = buildOperatorProjection({
      state: reconstructRunState(base, events),
      workflow,
    });
    const second = buildOperatorProjection({
      state: reconstructRunState(base, events),
      workflow,
    });
    expect(second).toEqual(first);
  });

  it("classifies errors with safe recovery metadata", () => {
    expect(
      classifyOperatorError({
        error: new Error("Harness adapter unavailable"),
      }),
    ).toMatchObject({
      schemaVersion: 1,
      category: "harness",
      retryable: true,
    });
  });
});
