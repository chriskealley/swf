import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  ArtifactStore,
  DeliveryOrchestrator,
  GitClient,
  HarnessWorkExecutor,
  HerdrClient,
  RunRuntime,
  RuntimeOwnershipStore,
  WorkflowScheduler,
  buildTaskAudit,
  discoverProjectChecks,
  inspectTemplateDiff,
  phaseContractFor,
  persistChangeDossier,
  recordHumanApproval,
  resolveDeliveryPlan,
  resolveModelRoute,
  retainDeliveryUpdate,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type HarnessAdapter,
  type CommandRunner,
  type DeliveryRequest,
  type DeliveryUpdate,
  type HostingAdapter,
  type ProcessResult,
  type PullRequestObservation,
  type Workflow,
} from "../packages/core/src/index.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

function pullRequestObservation(
  values: Partial<PullRequestObservation> = {},
): PullRequestObservation {
  return {
    number: 12,
    url: "https://github.com/acme/repo/pull/12",
    sourceBranch: "swf/run",
    targetBranch: "main",
    created: false,
    state: "open",
    mergeState: "CLEAN",
    checks: [],
    reviews: [],
    autoMergeEnabled: false,
    ...values,
  };
}

class AcceptanceHosting implements HostingAdapter {
  readonly id = "acceptance";
  readonly calls: string[] = [];
  observation = pullRequestObservation();
  async preflight() {
    this.calls.push("preflight");
    return {
      valid: true,
      skipped: false,
      repository: "acme/repo",
      checks: [],
    };
  }
  async createOrUpdatePullRequest() {
    this.calls.push("upsert");
    return pullRequestObservation({ created: true });
  }
  async observePullRequest() {
    this.calls.push("observe");
    return this.observation;
  }
  async requestAutoMerge() {
    this.calls.push("auto-merge");
  }
  async mergePullRequest() {
    this.calls.push("merge");
  }
  async directMerge() {
    this.calls.push("direct-merge");
  }
  async cleanupBranch() {
    this.calls.push("cleanup-branch");
  }
}

class CleanupRunner implements CommandRunner {
  readonly calls: string[] = [];
  async run(command: string, args: string[]): Promise<ProcessResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("execution-defaults acceptance", () => {
  it("runs every phase with static tier selection and leaves Releasing agent-free", async () => {
    const mappings = {
      reasoning: { pi: { model: "provider/reasoning" } },
      coding: { pi: { model: "provider/coding" } },
      fast: { pi: { model: "provider/fast" } },
    };
    const routes = {
      planning: resolveModelRoute({
        harness: "pi",
        modelTier: "reasoning",
        sources: { project: { modelTiers: mappings } },
      }).route,
      building: resolveModelRoute({
        harness: "pi",
        modelTier: "coding",
        sources: { project: { modelTiers: mappings } },
      }).route,
      reviewing: resolveModelRoute({
        harness: "pi",
        modelTier: "reasoning",
        sources: { project: { modelTiers: mappings } },
      }).route,
      verifying: resolveModelRoute({
        harness: "pi",
        modelTier: "fast",
        sources: { project: { modelTiers: mappings } },
      }).route,
    };
    const launches: AdapterLaunchRequest[] = [];
    const adapter: HarnessAdapter = {
      id: "pi",
      capabilities: {
        structuredEvents: true,
        modelSelection: true,
        toolSelection: true,
        cancellation: true,
        blockedInput: true,
        resume: false,
        usage: true,
      },
      availability: async () => ({ valid: true, errors: [] }),
      validate: async () => ({ valid: true, errors: [] }),
      launch: async (request) => {
        launches.push(request);
        return {
          invocationId: request.invocationId!,
          runId: request.runId,
          phaseId: request.phaseId,
          workUnitId: request.workUnitId,
          paneId: `pane-${request.phaseId}`,
          status: "completed",
          startedAt: new Date().toISOString(),
        };
      },
      submit: async () => undefined,
      observe: async () => ({ status: "completed", structuredEvents: [] }),
      cancel: async () => undefined,
      collect: async (_invocation: AdapterInvocation) => ({
        status: "completed",
        transcript: "complete",
        usage: { quality: "exact", totalTokens: 1 },
      }),
    };
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const phases = [
      ["planning", "planner"],
      ["building", "builder"],
      ["reviewing", "reviewer"],
      ["verifying", "verifier"],
    ] as const;
    const workflow: Workflow = {
      schemaVersion: 1,
      id: "execution-defaults-e2e",
      description: "Static model route acceptance",
      phases: [
        ...phases.map(([id, profile]) => ({
          id,
          title: id,
          profile,
          guidelines: [],
          requiredCapabilities: [],
          work: [
            {
              id: `${id}-agent`,
              type: "agent" as const,
              profile,
              options: { prompt: `complete ${id}` },
            },
          ],
          checks: [],
          gate: { mode: "automatic" as const },
        })),
        {
          id: "releasing",
          title: "Releasing",
          profile: "releaser",
          guidelines: [],
          requiredCapabilities: [],
          work: [],
          checks: [],
          gate: { mode: "automatic" },
        },
      ],
      delivery: { mode: "local-branch", mergeMethod: "merge" },
    };
    const scheduler = new WorkflowScheduler(
      workflow,
      new HarnessWorkExecutor(registry, {
        runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
        workspaceId: "workspace",
        cwd: "/isolated/worktree",
      }),
    );
    for (const [phaseId] of phases) {
      const route = routes[phaseId];
      await expect(
        scheduler.executePhase(
          phaseId,
          { eligible: true, reasons: [] },
          { project: { harness: "pi", model: route.concreteModel } },
        ),
      ).resolves.toMatchObject({ status: "completed" });
    }
    await expect(
      scheduler.executePhase(
        "releasing",
        { eligible: true, reasons: [] },
        { project: {} },
      ),
    ).resolves.toMatchObject({ status: "completed", work: [] });
    expect(launches.map(({ phaseId, model }) => ({ phaseId, model }))).toEqual([
      { phaseId: "planning", model: "provider/reasoning" },
      { phaseId: "building", model: "provider/coding" },
      { phaseId: "reviewing", model: "provider/reasoning" },
      { phaseId: "verifying", model: "provider/fast" },
    ]);
    expect(launches.some(({ phaseId }) => phaseId === "releasing")).toBe(false);
    expect(phaseContractFor("releasing").prohibitedActions).toContain("merge");
  });

  it("keeps review distinct from task verification and keeps discovery/default inspection read-only", async () => {
    expect(phaseContractFor("reviewing").objective).not.toBe(
      phaseContractFor("verifying").objective,
    );
    const root = await mkdtemp(join(tmpdir(), "swf-defaults-e2e-"));
    roots.push(root);
    const packageContents = JSON.stringify({ scripts: { test: "echo test" } });
    await writeFile(join(root, "package.json"), packageContents);
    const discovered = await discoverProjectChecks(root);
    expect(discovered.candidates[0]).toMatchObject({
      proposedPhase: "verifying",
      command: "pnpm run test",
    });
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      packageContents,
    );
    await writeFile(join(root, "profile.yaml"), "project\n");
    const diff = await inspectTemplateDiff({
      configDirectory: root,
      adopted: undefined,
      installed: { "profile.yaml": "installed\n" },
    });
    expect(diff[0]?.status).toBe("conflict");
    expect(await readFile(join(root, "profile.yaml"), "utf8")).toBe(
      "project\n",
    );
    const audit = buildTaskAudit({
      tasksContents: "- [x] 1.1 Done\n",
      tasksPath: "tasks.md",
      sourceCommit: "abc",
      implementationRefs: ["src/app.ts"],
      checks: [
        {
          checkId: "test",
          type: "command",
          required: true,
          status: "passed",
          deterministic: true,
          createdAt: new Date().toISOString(),
          summary: "passed",
        },
      ],
    });
    expect(audit.status).toBe("verified");
  });

  it("preserves failed delivery state and durably records approved automatic delivery before owned cleanup", async () => {
    const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";
    const root = await mkdtemp(join(tmpdir(), "swf-release-e2e-"));
    roots.push(root);
    const stateDirectory = join(root, ".swf-state");
    const changeRoot = join(root, "openspec", "changes", "release-e2e");
    const artifacts = new ArtifactStore(stateDirectory, runId);
    const ownership = new RuntimeOwnershipStore(stateDirectory);
    await ownership.save({
      schemaVersion: 1,
      runId,
      projectRoot: root,
      branch: "swf/run",
      worktreePath: join(stateDirectory, "worktrees", runId),
      resources: [
        {
          kind: "workspace",
          resourceId: "owned-workspace",
          createdAt: new Date().toISOString(),
        },
        {
          kind: "pane",
          resourceId: "owned-pane",
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const approval = recordHumanApproval({
      runId,
      phaseId: "releasing",
      actor: { type: "user", id: "release-operator" },
      decision: "approved",
      reason: "verified release dossier",
    });
    expect(approval).toMatchObject({
      phaseId: "releasing",
      decision: "approved",
    });

    const authorizationId = "1a45f716-bdaa-4bba-a7b2-b4890069f22b";
    const plan = resolveDeliveryPlan({
      configuredMode: "pull-request",
      mergeMethod: "squash",
      explicitlyConfigured: true,
      authorization: {
        approvalMode: "automatic",
        delegatedAuthorization: true,
        directMergeAuthorized: false,
      },
    });
    const request: DeliveryRequest = {
      cwd: root,
      remote: "origin",
      sourceBranch: "swf/run",
      targetBranch: "main",
      title: "Release acceptance",
      body: "Durable release acceptance",
      runId,
      executionStatus: "completed",
      sourceCommit: "source-commit",
      phaseId: "releasing",
      plan,
      failureAction: "escalate",
      authorizationId,
      dossierRef: "evidence/dossier.json",
    };
    const failedHosting = new AcceptanceHosting();
    failedHosting.observation = pullRequestObservation({
      checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
    });
    const failedOrchestrator = new DeliveryOrchestrator(failedHosting);
    const failedStart = await failedOrchestrator.start(request);
    const failed = await failedOrchestrator.monitor({
      ...request,
      delivery: failedStart,
      maxPolls: 1,
      pollIntervalMs: 0,
    });
    expect(failed).toMatchObject({
      status: "checks-failed",
      authorizationId,
    });
    expect(failedHosting.calls).not.toContain("cleanup-branch");
    expect(await ownership.load(runId)).toBeDefined();

    const successfulHosting = new AcceptanceHosting();
    successfulHosting.observation = pullRequestObservation({
      state: "merged",
      mergeState: "MERGED",
      checks: [{ name: "ci", status: "completed", conclusion: "success" }],
    });
    const updates: DeliveryUpdate[] = [];
    const successfulOrchestrator = new DeliveryOrchestrator(
      successfulHosting,
      async (update) => {
        updates.push(update);
        await retainDeliveryUpdate({
          artifacts,
          update,
          sourceCommit: request.sourceCommit,
          phaseId: "releasing",
        });
      },
    );
    const started = await successfulOrchestrator.start(request);
    const delivered = await successfulOrchestrator.monitor({
      ...request,
      delivery: started,
      maxPolls: 1,
      pollIntervalMs: 0,
    });
    expect(delivered).toMatchObject({
      status: "merged",
      autoMergeRequested: true,
      authorizationId,
      cleanup: { branchDeleted: true },
    });
    expect(successfulHosting.calls).toEqual([
      "preflight",
      "upsert",
      "auto-merge",
      "preflight",
      "observe",
      "cleanup-branch",
    ]);
    expect(updates.map(({ kind }) => kind)).toEqual([
      "pull-request",
      "merge",
      "merge",
      "cleanup",
    ]);

    const dossier = await persistChangeDossier({
      changeRoot,
      runId,
      artifacts,
      approvals: [approval],
      deliveries: [delivered],
      finalReport: "Approved automatic release completed",
    });
    expect(dossier.dossier).toMatchObject({
      approvals: [{ phaseId: "releasing", decision: "approved" }],
      deliveryReferences: [
        {
          status: "merged",
          authorizationId,
          dossierRef: "evidence/dossier.json",
        },
      ],
    });
    expect(await readFile(dossier.path, "utf8")).toContain(authorizationId);

    const cleanupRunner = new CleanupRunner();
    const removed = await new RunRuntime(
      new GitClient(root, cleanupRunner),
      new HerdrClient(cleanupRunner),
      ownership,
    ).cleanup(runId);
    expect(removed).toEqual(["owned-pane", "owned-workspace"]);
    expect(cleanupRunner.calls).toContain("herdr pane close owned-pane");
    expect(cleanupRunner.calls).toContain(
      "herdr workspace close owned-workspace",
    );
    expect(cleanupRunner.calls.some((call) => call.includes("unowned"))).toBe(
      false,
    );
    expect(await ownership.load(runId)).toBeUndefined();
  });
});
