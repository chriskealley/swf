import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorProjection, SwfServiceClient } from "@swf/core";
import {
  AmbiguousOperatorContextError,
  resolveOperatorContext,
  resolveUniqueAction,
} from "../src/operator-context.js";
import {
  interactionEnabled,
  runApprovalDecisionFlow,
} from "../src/interaction.js";
import {
  projectionFromResult,
  renderActionCommand,
  renderOperatorProjection,
} from "../src/operator-renderer.js";
import {
  OrderedProgressSubscriber,
  renderProgressLine,
} from "../src/progress.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

function projection(
  overrides: Partial<OperatorProjection> = {},
): OperatorProjection {
  return {
    schemaVersion: 1,
    projectId,
    runId,
    changeName: "operator-test",
    workflowId: "default",
    status: "blocked",
    summary: "operator-test is blocked; planning requires approval.",
    currentPhaseId: "planning",
    stoppingPhaseId: "planning",
    attention: [],
    allowedActions: [],
    evidence: { checks: [], changedPaths: [], risks: [], artifactIds: [] },
    ...overrides,
  };
}

function fakeClient(queries: Record<string, unknown>): SwfServiceClient {
  return {
    query: vi.fn(async (resource: string) => queries[resource]),
  } as unknown as SwfServiceClient;
}

describe("CLI operator context", () => {
  it("resolves the project from --cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-cli-context-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".swf"));
    await writeFile(
      join(root, ".swf", "config.yaml"),
      `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
    );
    const client = fakeClient({
      runs: [{ runId, changeName: "operator-test" }],
      "operator-projection": projection(),
    });
    await expect(
      resolveOperatorContext({
        client,
        cwd: root,
        changeName: "operator-test",
      }),
    ).resolves.toMatchObject({ projectId, runId, root: await realpath(root) });
  });

  it("resolves a change-bound run and retains explicit selectors", async () => {
    const client = fakeClient({
      runs: [{ runId, changeName: "operator-test" }],
      "operator-projection": projection(),
    });
    await expect(
      resolveOperatorContext({
        client,
        projectId,
        changeName: "operator-test",
      }),
    ).resolves.toMatchObject({ projectId, runId, changeName: "operator-test" });
    await expect(
      resolveOperatorContext({ client, projectId, runId }),
    ).resolves.toMatchObject({ projectId, runId });
  });

  it("reports missing bindings and refuses ambiguous runs", async () => {
    await expect(
      resolveOperatorContext({
        client: fakeClient({ runs: [] }),
        projectId,
        changeName: "missing",
      }),
    ).rejects.toThrow("No run is bound");
    await expect(
      resolveOperatorContext({
        client: fakeClient({
          runs: [
            { runId, changeName: "operator-test" },
            {
              runId: "33333333-3333-4333-8333-333333333333",
              changeName: "operator-test",
            },
          ],
        }),
        projectId,
        changeName: "operator-test",
      }),
    ).rejects.toBeInstanceOf(AmbiguousOperatorContextError);
  });

  it("infers only one matching semantic action", () => {
    const approve = {
      actionId: "approve:one",
      type: "approve" as const,
      label: "Approve planning",
      parameters: {
        projectId,
        runId,
        changeName: "operator-test",
        phaseId: "planning",
        gateId: "gate",
      },
      requiresConfirmation: true,
      recommended: true,
    };
    expect(
      resolveUniqueAction(projection({ allowedActions: [approve] }), [
        "approve",
      ]),
    ).toEqual(approve);
    expect(() =>
      resolveUniqueAction(
        projection({
          allowedActions: [
            approve,
            {
              ...approve,
              actionId: "approve:two",
              parameters: { ...approve.parameters, phaseId: "building" },
            },
          ],
        }),
        ["approve"],
      ),
    ).toThrow(AmbiguousOperatorContextError);
  });
});

describe("CLI human rendering", () => {
  it("renders approval evidence and executable commands without internal IDs", () => {
    const approve = {
      actionId: "approve:one",
      type: "approve" as const,
      label: "Approve planning",
      parameters: {
        projectId,
        runId,
        changeName: "operator-test",
        phaseId: "planning",
        gateId: "gate",
      },
      requiresConfirmation: true,
      recommended: true,
    };
    const value = projection({
      attention: [
        {
          attentionId: "attention:one",
          type: "manual-approval",
          projectId,
          runId,
          changeName: "operator-test",
          phaseId: "planning",
          gateId: "gate",
          title: "planning requires approval",
          reason: "Review planning evidence",
          retryable: false,
          evidence: {
            checks: [{ id: "openspec", status: "passed" }],
            changedPaths: ["openspec/changes/operator-test/tasks.md"],
            risks: ["migration risk"],
            artifactIds: ["44444444-4444-4444-8444-444444444444"],
          },
          actionIds: [approve.actionId],
        },
      ],
      allowedActions: [approve],
    });
    const rendered = renderOperatorProjection(value);
    expect(rendered).toContain("Approval required: planning");
    expect(rendered).toContain("openspec passed");
    expect(rendered).toContain("Handoff risks: migration risk");
    expect(rendered).toContain("swf approve operator-test");
    expect(rendered).not.toContain(projectId);
    expect(renderOperatorProjection(value, { verbose: true })).toContain(
      projectId,
    );
    expect(renderActionCommand(approve)).toBe("swf approve operator-test");
    expect(projectionFromResult({ projection: value })).toEqual(value);
  });

  it("renders paused and completed local delivery states", () => {
    expect(
      renderOperatorProjection(
        projection({
          status: "paused",
          completedPhaseId: "planning",
          nextPhaseId: "building",
          summary: "planning completed",
        }),
      ),
    ).toContain("Next phase: building");
    expect(
      renderOperatorProjection(
        projection({
          status: "completed",
          summary: "workflow completed",
          delivery: {
            deliveryId: "55555555-5555-4555-8555-555555555555",
            status: "local-branch",
            branch: "swf/operator-test",
            targetBranch: "main",
            dossierRef: "dossier.json",
            checkpointCount: 4,
          },
        }),
      ),
    ).toContain("Branch: swf/operator-test → main");
  });
});

describe("CLI progress and interaction", () => {
  it("renders bounded normal milestones and ignores unrelated events", async () => {
    const lines: string[] = [];
    const subscriber = new OrderedProgressSubscriber((line) =>
      lines.push(line),
    );
    await subscriber.follow(
      async function* () {
        yield { id: 1, type: "service.started", data: {} };
        yield {
          id: 2,
          type: "work-unit.transitioned",
          data: {
            event: { context: { phaseId: "building" }, data: {} },
          },
        };
        yield {
          id: 3,
          type: "harness.progress",
          data: {
            event: {
              type: "blocked",
              harness: "pi",
              context: { phaseId: "building" },
            },
          },
        };
        yield { id: 4, type: "delivery.recorded", data: {} };
      },
      { attempts: 1 },
    );
    expect(lines).toEqual([
      "work-unit.transitioned building",
      "harness.blocked building pi",
      "delivery.recorded",
    ]);
  });

  it("continues ordered milestones across reconnect and suppresses duplicates", async () => {
    const lines: string[] = [];
    const subscriber = new OrderedProgressSubscriber(
      (line) => lines.push(line),
      { projectId },
    );
    let calls = 0;
    const result = await subscriber.follow(async function* (after) {
      calls += 1;
      if (calls === 1) {
        yield {
          id: 1,
          type: "phase.started",
          projectId,
          data: { phaseId: "planning" },
        };
        throw new Error("stream lost");
      }
      expect(after).toBe(1);
      yield {
        id: 1,
        type: "phase.started",
        projectId,
        data: { phaseId: "planning" },
      };
      yield {
        id: 2,
        type: "check.completed",
        projectId,
        data: { phaseId: "planning" },
      };
    });
    expect(result).toEqual({ connected: true, lastEventId: 2 });
    expect(lines).toEqual([
      "phase.started planning",
      "check.completed planning",
    ]);
    expect(renderProgressLine("phase.started", false)).toBe("phase.started");
    expect(renderProgressLine("phase.started", true)).not.toContain(
      String.fromCharCode(27),
    );
  });

  it("treats total stream loss as non-authoritative and still renders final state", async () => {
    const subscriber = new OrderedProgressSubscriber(() => undefined);
    const emitUnexpectedEvent = process.env.SWF_TEST_UNEXPECTED_EVENT === "1";
    const stream = await subscriber.follow(
      async function* () {
        if (emitUnexpectedEvent) yield { id: 0, type: "run.started", data: {} };
        throw new Error("offline");
      },
      { attempts: 2 },
    );
    expect(stream.connected).toBe(false);
    expect(
      renderOperatorProjection(
        projection({ status: "paused", completedPhaseId: "planning" }),
      ),
    ).toContain("Completed phase: planning");
  });

  it.each([
    { json: true, stdinTty: true, stdoutTty: true },
    { stdinTty: false, stdoutTty: true },
    { stdinTty: true, stdoutTty: false },
    { stdinTty: true, stdoutTty: true, noInteractive: true },
    { stdinTty: true, stdoutTty: true, ci: true },
  ])("never prompts in automation: %o", (input) => {
    expect(interactionEnabled({ interactive: true, ...input })).toBe(false);
  });

  it("requires explicit confirmation and preserves actor and reason", async () => {
    const selected = {
      actionId: "approve:one",
      type: "approve" as const,
      label: "Approve planning",
      parameters: {
        projectId,
        runId,
        changeName: "operator-test",
        phaseId: "planning",
        gateId: "planning-gate",
      },
      requiresConfirmation: true,
      recommended: true,
    };
    const submit = vi.fn(async () => ({
      projection: projection({ status: "paused" }),
    }));
    const result = await runApprovalDecisionFlow({
      projection: projection({ allowedActions: [selected] }),
      actor: "chris",
      choose: async () => selected,
      confirm: async () => true,
      reason: async () => "Evidence reviewed",
      submit,
    });
    expect(result.status).toBe("submitted");
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "approve",
        actorId: "chris",
        reason: "Evidence reviewed",
      }),
    );
    const declined = vi.fn();
    await runApprovalDecisionFlow({
      projection: projection({ allowedActions: [selected] }),
      actor: "chris",
      choose: async () => selected,
      confirm: async () => false,
      reason: async () => undefined,
      submit: declined,
    });
    expect(declined).not.toHaveBeenCalled();
  });
});
