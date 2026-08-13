import { describe, expect, it } from "vitest";
import type { OperatorProjection } from "../packages/core/src/index.ts";
import { cliGuidanceIdentity } from "../apps/cli/src/operator-renderer.ts";
import { piGuidanceIdentity } from "../extensions/pi/src/index.ts";
import { dashboardGuidanceIdentity } from "../apps/dashboard/src/model.ts";

describe("cross-client operator guidance", () => {
  it("uses the same stopping phase, attention, and semantic actions", () => {
    const projection: OperatorProjection = {
      schemaVersion: 1,
      projectId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      changeName: "operator-test",
      workflowId: "default",
      status: "blocked",
      summary: "Planning requires approval",
      currentPhaseId: "planning",
      stoppingPhaseId: "planning",
      attention: [
        {
          attentionId: "manual:planning",
          type: "manual-approval",
          projectId: "11111111-1111-4111-8111-111111111111",
          runId: "22222222-2222-4222-8222-222222222222",
          changeName: "operator-test",
          phaseId: "planning",
          gateId: "planning-gate",
          title: "Planning requires approval",
          reason: "Review evidence",
          retryable: false,
          actionIds: ["approve:planning"],
        },
      ],
      allowedActions: [
        {
          actionId: "approve:planning",
          type: "approve",
          label: "Approve planning",
          parameters: {
            projectId: "11111111-1111-4111-8111-111111111111",
            runId: "22222222-2222-4222-8222-222222222222",
            changeName: "operator-test",
            phaseId: "planning",
            gateId: "planning-gate",
          },
          requiresConfirmation: true,
          recommended: true,
        },
      ],
      evidence: { checks: [], changedPaths: [], risks: [], artifactIds: [] },
    };
    const expected = cliGuidanceIdentity(projection);
    expect(piGuidanceIdentity(projection)).toEqual(expected);
    expect(dashboardGuidanceIdentity(projection)).toEqual(expected);
  });
});
