import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedAgentRouter,
  HerdrClient,
  PiHarnessAdapter,
  WorkflowScheduler,
  applyRerunInvalidation,
  assertAdapterConformance,
  authorizePhaseRerun,
  assertMutatingOrchestrationAllowed,
  childInvocationEnvironment,
  createRunState,
  evaluatePhaseEligibility,
  normalizePlanningInput,
  previewPhaseRerun,
  produceDefaultPlanningArtifacts,
  validatePlanningArtifacts,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type CommandOptions,
  type CommandRunner,
  type HarnessAdapter,
  type ProcessResult,
  type Workflow,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "swf-scheduler-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const workflow: Workflow = {
  schemaVersion: 1,
  id: "default",
  description: "Test workflow",
  phases: [
    {
      id: "planning",
      title: "Planning",
      profile: "planner",
      guidelines: [],
      requiredCapabilities: ["structured-events"],
      work: [
        { id: "plan-agent", type: "agent", profile: "planner", options: {} },
        {
          id: "plan-command",
          type: "command",
          command: "echo plan",
          options: {},
        },
        {
          id: "plan-composite",
          type: "sequential",
          options: {
            steps: [
              { id: "nested-human", type: "human", options: {} },
              { id: "nested-openspec", type: "openspec", options: {} },
            ],
          },
        },
      ],
      checks: [],
      gate: { mode: "manual" },
    },
    {
      id: "building",
      title: "Building",
      profile: "builder",
      guidelines: [],
      requiredCapabilities: [],
      work: [],
      checks: [],
      gate: { mode: "automatic" },
    },
  ],
  delivery: { mode: "local-branch", mergeMethod: "merge" },
};

function state() {
  return createRunState({
    schemaVersion: 1,
    runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
    projectId: "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b",
    changeName: "add-user-auth",
    changeIdentity: "changes/add-user-auth#2026-04-02",
    workflowId: "default",
    phaseIds: ["planning", "building"],
    description: "Add authentication",
    status: "running",
    createdAt: "2026-04-02T12:00:00.000Z",
    updatedAt: "2026-04-02T12:00:00.000Z",
  });
}

class FakeHerdrRunner implements CommandRunner {
  readonly calls: string[] = [];
  status = "idle";

  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "which")
      return { code: args[0] === "pi" ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "integration")
      return { code: 0, stdout: "pi: installed\n", stderr: "" };
    if (args.slice(0, 2).join(" ") === "tab create")
      return {
        code: 0,
        stdout:
          '{"tab":{"tab_id":"t1"},"pane":{"pane_id":"p1","terminal_id":"term1","process_id":"proc1"}}',
        stderr: "",
      };
    if (args.slice(0, 2).join(" ") === "pane get")
      return {
        code: 0,
        stdout: JSON.stringify({
          pane: { pane_id: "p1", agent_status: this.status },
        }),
        stderr: "",
      };
    if (args.slice(0, 2).join(" ") === "pane read")
      return {
        code: 0,
        stdout:
          '{"usage":{"input_tokens":3,"output_tokens":5,"cost_usd":0.01}}\n{"type":"agent_settled"}\n',
        stderr: "",
      };
    return { code: 0, stdout: "{}", stderr: "" };
  }
}

class FakeAdapter implements HarnessAdapter {
  readonly id = "fake";
  readonly capabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: true,
    resume: false,
    usage: true,
  };
  submitted: string[] = [];

  async availability(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }

  async validate(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }

  async launch(request: AdapterLaunchRequest): Promise<AdapterInvocation> {
    return {
      invocationId: "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133",
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: "p1",
      status: "running",
      startedAt: "2026-04-02T12:00:00.000Z",
    };
  }

  async submit(_invocation: AdapterInvocation, prompt: string): Promise<void> {
    this.submitted.push(prompt);
  }

  async observe(): Promise<AdapterObservation> {
    return { status: "completed", structuredEvents: [] };
  }

  async cancel(): Promise<void> {}

  async collect(): Promise<AdapterResult> {
    return {
      status: "completed",
      transcript: "done",
      usage: { quality: "unknown" },
    };
  }
}

describe("workflow scheduling and adapters", () => {
  it("executes typed work units in declared sequential order with resolved phase configuration", async () => {
    const calls: string[] = [];
    const scheduler = new WorkflowScheduler(workflow, {
      async execute(unit) {
        calls.push(unit.id);
        return { status: "completed", output: unit.type };
      },
    });
    const runState = state();
    const eligibility = evaluatePhaseEligibility(workflow, "planning", {
      state: runState,
      worktreeAtCheckpoint: true,
      artifactsValid: true,
      entryChecksPass: true,
      policyAllows: true,
      budgetAvailable: true,
      adapter: new FakeAdapter(),
    });
    const result = await scheduler.executePhase("planning", eligibility, {
      project: { harness: "pi", timeoutMs: 20 },
      phase: { model: "openai/gpt-test" },
    });

    expect(result.status).toBe("completed");
    expect(
      scheduler.resolvePhaseExecution(workflow.phases[0]!, {
        project: {
          harness: "pi",
          timeoutMs: 20,
          artifactContext: ["proposal"],
        },
        phase: { model: "openai/gpt-test", retryLimit: 2, budgetUsd: 5 },
      }),
    ).toMatchObject({
      harness: "pi",
      model: "openai/gpt-test",
      profile: "planner",
      timeoutMs: 20,
      retryLimit: 2,
      budgetUsd: 5,
      artifactContext: ["proposal"],
    });
    expect(calls).toEqual([
      "plan-agent",
      "plan-command",
      "nested-human",
      "nested-openspec",
    ]);
    expect(result.resolved).toMatchObject({
      harness: "pi",
      model: "openai/gpt-test",
      timeoutMs: 20,
    });
  });

  it("explains ineligible work and previews explicit rerun invalidation", () => {
    const runState = state();
    const eligibility = evaluatePhaseEligibility(workflow, "building", {
      state: runState,
      activePhaseId: "planning",
      worktreeAtCheckpoint: false,
      artifactsValid: false,
      entryChecksPass: false,
      policyAllows: false,
      budgetAvailable: false,
      adapter: new FakeAdapter(),
      requiredCapabilities: ["resume"],
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons.join(" ")).toContain("Predecessor planning");
    expect(eligibility.reasons.join(" ")).toContain(
      "lacks required capability: resume",
    );

    runState.phases.planning!.status = "completed";
    const preview = previewPhaseRerun(workflow, runState, "planning");
    expect(preview).toMatchObject({
      invalidatedPhaseIds: ["planning", "building"],
    });
    expect(() => authorizePhaseRerun(preview, false)).toThrow(
      "requires explicit authorization",
    );
    const invalidated = applyRerunInvalidation(
      runState,
      authorizePhaseRerun(preview, true),
    );
    expect(invalidated.phases.planning?.status).toBe("pending");
  });

  it("launches Pi via Herdr with model and tool choices and passes adapter conformance", async () => {
    const runner = new FakeHerdrRunner();
    const adapter = new PiHarnessAdapter(new HerdrClient(runner));
    const request: AdapterLaunchRequest = {
      runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
      phaseId: "planning",
      workUnitId: "plan-agent",
      workspaceId: "w1",
      cwd: "/worktree",
      prompt: "Plan the change",
      model: "openai/gpt-test",
      tools: ["read", "bash"],
      excludeTools: ["write"],
    };
    await assertAdapterConformance(adapter, {
      request,
      requiredCapabilities: ["structured-events", "model-selection"],
    });
    const invocation = await adapter.launch(request);
    const result = await adapter.collect(invocation);
    expect(result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
      quality: "exact",
    });
    expect(
      runner.calls.some((call) =>
        call.includes(
          "'pi' '--mode' 'rpc' '--no-session' '--model' 'openai/gpt-test'",
        ),
      ),
    ).toBe(true);
  });

  it("routes blocked input only to the recorded owned invocation", async () => {
    const adapter = new FakeAdapter();
    const invocation = await adapter.launch({
      runId: "run",
      phaseId: "planning",
      workUnitId: "agent",
      workspaceId: "w1",
      cwd: "/repo",
      prompt: "go",
    });
    const router = new BlockedAgentRouter();
    const input = router.report(adapter, invocation, {
      status: "blocked",
      blockedPrompt: "Choose an option",
      structuredEvents: [],
    });
    expect(router.list()).toEqual([input]);
    await router.submit(invocation.invocationId, "Option A");
    expect(adapter.submitted).toEqual(["Option A"]);
    await expect(router.submit("unknown", "no")).rejects.toThrow(
      "No blocked invocation",
    );
  });
});

describe("Planning and child execution boundaries", () => {
  it("normalizes Planning input and produces validated OpenSpec planning artifacts", async () => {
    const root = await temporaryDirectory();
    const planning = normalizePlanningInput({
      description: "Add API token authentication",
    });
    await produceDefaultPlanningArtifacts({
      changeRoot: root,
      changeName: "add-user-auth",
      planning,
    });
    await expect(validatePlanningArtifacts(root)).resolves.toEqual([]);
    expect(
      normalizePlanningInput({
        exploration: {
          explorationId: "e1",
          problem: "Explore auth",
          goals: [],
          nonGoals: [],
          options: [],
          decisions: [],
          openQuestions: [],
          codebaseFindings: [],
          candidateScope: "auth",
          candidateChangeName: "add-user-auth",
        },
      }),
    ).toMatchObject({ kind: "exploration" });
  });

  it("injects child metadata and rejects recursive orchestration unless explicitly allowed", () => {
    const environment = childInvocationEnvironment({
      runId: "run",
      phaseId: "planning",
      invocationId: "invocation",
    });
    expect(environment).toMatchObject({
      SWF_CHILD_MODE: "1",
      SWF_RUN_ID: "run",
      SWF_PHASE_ID: "planning",
    });
    expect(() => assertMutatingOrchestrationAllowed(environment)).toThrow(
      "Child phase invocations",
    );
    expect(() =>
      assertMutatingOrchestrationAllowed({
        ...environment,
        SWF_ALLOW_NESTED_ORCHESTRATION: "1",
      }),
    ).not.toThrow();
  });
});
