import { describe, expect, it } from "vitest";
import {
  WorkflowScheduler,
  createRunState,
  createSetupPlan,
  evaluatePhaseEligibility,
  validateJsonDocument,
  type Workflow,
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

  it("runs one Pi agent unit and one command unit sequentially in the shared run worktree", async () => {
    const workflow: Workflow = {
      schemaVersion: 1,
      id: "vertical-slice",
      description: "Pi then command",
      phases: [
        {
          id: "planning",
          title: "Planning",
          profile: "planner",
          guidelines: [],
          requiredCapabilities: [],
          work: [
            { id: "pi-agent", type: "agent", profile: "planner", options: {} },
            {
              id: "verify-command",
              type: "command",
              command: "echo verified",
              options: {},
            },
          ],
          checks: [],
          gate: { mode: "automatic" },
        },
      ],
      delivery: { mode: "local-branch", mergeMethod: "merge" },
    };
    const sharedWorktree = "/isolated/run-worktree";
    const calls: Array<{ unit: string; cwd: string }> = [];
    const scheduler = new WorkflowScheduler(workflow, {
      async execute(unit, context) {
        calls.push({
          unit: unit.id,
          cwd: context.resolved.worktreePath as string,
        });
        return { status: "completed" };
      },
    });
    const state = createRunState({
      schemaVersion: 1,
      runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
      projectId: "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b",
      changeName: "add-user-auth",
      workflowId: "vertical-slice",
      description: "Test",
      status: "running",
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      phaseIds: ["planning"],
    });
    const eligibility = evaluatePhaseEligibility(workflow, "planning", {
      state,
      worktreeAtCheckpoint: true,
      artifactsValid: true,
      entryChecksPass: true,
      policyAllows: true,
      budgetAvailable: true,
    });
    await expect(
      scheduler.executePhase("planning", eligibility, {
        project: { worktreePath: sharedWorktree },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(calls).toEqual([
      { unit: "pi-agent", cwd: sharedWorktree },
      { unit: "verify-command", cwd: sharedWorktree },
    ]);
  });
});
