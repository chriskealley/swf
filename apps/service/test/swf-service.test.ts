import {
  mkdir,
  readFile,
  realpath,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultTemplateFiles,
  HerdrClient,
  NodeCommandRunner,
  RunEventStore,
  produceDefaultPlanningArtifacts,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type HarnessAdapter,
  type HostingAdapter,
  type HostingPreflightInput,
  type HostingPreflightResult,
  type CommandOptions,
  type CommandRunner,
  type ProcessResult,
  type PullRequestObservation,
} from "@swf/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperatorCommandError,
  ServiceAlreadyRunningError,
  ServiceAuthenticationError,
  SwfService,
} from "../src/server/swf-service.js";

const directories: string[] = [];
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), prefix)),
  );
  directories.push(directory);
  return directory;
}

async function setup(): Promise<{ service: SwfService; projectRoot: string }> {
  const home = await temporaryDirectory("swf-service-");
  const projectRoot = await temporaryDirectory("swf-service-project-");
  await mkdir(join(projectRoot, ".git"));
  await mkdir(join(projectRoot, ".swf", "workflows"), { recursive: true });
  await mkdir(join(projectRoot, ".swf", "policies"), { recursive: true });
  await writeFile(
    join(projectRoot, ".swf", "config.yaml"),
    `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "workflows", "default.yaml"),
    `schemaVersion: 1\nid: default\ndescription: Service test\nphases:\n  - id: planning\n    title: Planning\n    profile: planner\n    guidelines: []\n    requiredCapabilities: []\n    work: []\n    checks: []\n    gate:\n      mode: manual\ndelivery:\n  mode: local-branch\n  mergeMethod: merge\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "policies", "manual.yaml"),
    `schemaVersion: 1\nid: manual\napprovalMode: manual\nmaxAttempts: 1\nriskOverrides: []\n`,
  );
  const service = new SwfService({
    serviceHome: home,
    endpoint: "http://127.0.0.1:45001",
    projectTrust: async () => true,
  });
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Test project",
    root: projectRoot,
  });
  return { service, projectRoot };
}

async function createRun(
  projectRoot: string,
  options: { policyId?: string } = {},
): Promise<void> {
  const store = new RunEventStore(join(projectRoot, ".swf-state"));
  await store.create({
    projectId,
    runId,
    changeName: "add-user-auth",
    changeIdentity: "changes/add-user-auth#2026-04-02",
    workflowId: "default",
    policyId: options.policyId,
    description: "Add token authentication",
    phaseIds: ["planning"],
  });
}

async function setupPhaseContracts(): Promise<{
  service: SwfService;
  projectRoot: string;
}> {
  const home = await temporaryDirectory("swf-service-contracts-");
  const projectRoot = await temporaryDirectory(
    "swf-service-contracts-project-",
  );
  await mkdir(join(projectRoot, ".git"));
  for (const [relativePath, contents] of Object.entries(
    defaultTemplateFiles(projectId),
  )) {
    const path = join(projectRoot, ".swf", relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  await writeFile(
    join(projectRoot, ".swf", "models.yaml"),
    "schemaVersion: 1\nmodelTiers:\n  reasoning:\n    pi:\n      model: test/reasoning\n  coding:\n    pi:\n      model: test/coding\n  fast:\n    pi:\n      model: test/fast\n",
  );
  const service = new SwfService({
    serviceHome: home,
    projectTrust: async () => true,
  });
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Contract project",
    root: projectRoot,
  });
  await new RunEventStore(join(projectRoot, ".swf-state")).create({
    projectId,
    runId,
    changeName: "contract-change",
    changeIdentity: "changes/contract-change",
    workflowId: "default",
    description: "Exercise every phase contract",
    phaseIds: ["planning", "building", "reviewing", "verifying", "releasing"],
  });
  return { service, projectRoot };
}

class SimulatedHerdrRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    if (command !== "herdr")
      return { code: 1, stdout: "", stderr: "unexpected" };
    if (args[0] === "workspace" && args[1] === "create")
      return {
        code: 0,
        stdout: JSON.stringify({
          workspace: { workspace_id: "service-workspace" },
        }),
        stderr: "",
      };
    if (args[0] === "worktree" && args[1] === "open")
      return {
        code: 0,
        stdout: JSON.stringify({
          worktree: { worktree_id: "service-worktree" },
        }),
        stderr: "",
      };
    return { code: 0, stdout: "{}", stderr: "" };
  }
}

class FakePlanningAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly capabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: true,
    resume: false,
    usage: true,
  };
  async availability(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }
  async validate(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }
  async launch(request: AdapterLaunchRequest): Promise<AdapterInvocation> {
    const match = request.prompt.match(/OpenSpec change ([a-z][a-z0-9-]*)/);
    const changeName = match?.[1];
    if (!changeName)
      throw new Error("Planning prompt did not identify the change");
    await produceDefaultPlanningArtifacts({
      changeRoot: join(request.cwd, "openspec", "changes", changeName),
      changeName,
      planning: { kind: "description", description: "Service-backed planning" },
    });
    return {
      invocationId: crypto.randomUUID(),
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: "service-pane",
      status: "completed",
      startedAt: new Date().toISOString(),
    };
  }
  async submit(): Promise<void> {}
  async observe(): Promise<AdapterObservation> {
    return { status: "completed", structuredEvents: [] };
  }
  async cancel(): Promise<void> {}
  async collect(): Promise<AdapterResult> {
    return {
      status: "completed",
      transcript: "simulated planning complete",
      usage: { quality: "unknown" },
    };
  }
}

class FakeHostingAdapter implements HostingAdapter {
  readonly id = "fake-github";
  upserts = 0;
  autoMerges = 0;
  cleanups = 0;
  private resolveObservation!: (value: PullRequestObservation) => void;
  private observation = new Promise<PullRequestObservation>((resolve) => {
    this.resolveObservation = resolve;
  });

  release(observation: Partial<PullRequestObservation> = {}): void {
    this.resolveObservation({
      number: 4,
      url: "https://github.com/acme/repo/pull/4",
      sourceBranch: `swf/${runId}`,
      targetBranch: "main",
      created: false,
      state: "merged",
      mergeState: "MERGED",
      checks: [],
      reviews: [],
      autoMergeEnabled: false,
      ...observation,
    });
  }

  async preflight(
    _input: HostingPreflightInput,
  ): Promise<HostingPreflightResult> {
    return {
      valid: true,
      skipped: false,
      repository: "acme/repo",
      checks: [],
    };
  }
  async createOrUpdatePullRequest() {
    this.upserts += 1;
    return {
      number: 4,
      url: "https://github.com/acme/repo/pull/4",
      sourceBranch: `swf/${runId}`,
      targetBranch: "main",
      created: this.upserts === 1,
    };
  }
  async observePullRequest() {
    return this.observation;
  }
  async requestAutoMerge() {
    this.autoMerges += 1;
  }
  async mergePullRequest() {}
  async directMerge() {}
  async cleanupBranch() {
    this.cleanups += 1;
  }
}

class ArchiveCommandRunner extends NodeCommandRunner {
  readonly archiveCalls: string[][] = [];
  override async run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<ProcessResult> {
    if (command === "openspec") {
      this.archiveCalls.push(args);
      return { code: 0, stdout: "archived\n", stderr: "" };
    }
    return super.run(command, args, options);
  }
}

async function setupDelivery(
  adapter: HostingAdapter,
  failureAction: "remediate" | "escalate" | "fail" = "escalate",
  policyId: "manual" | "autonomous" = "manual",
  commandRunner?: CommandRunner,
): Promise<{ service: SwfService; projectRoot: string }> {
  const home = await temporaryDirectory("swf-service-delivery-");
  const projectRoot = await temporaryDirectory("swf-service-delivery-project-");
  await mkdir(join(projectRoot, ".git"));
  await mkdir(join(projectRoot, ".swf", "workflows"), { recursive: true });
  await mkdir(join(projectRoot, ".swf", "policies"), { recursive: true });
  await writeFile(
    join(projectRoot, ".swf", "config.yaml"),
    `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "workflows", "default.yaml"),
    `schemaVersion: 1\nid: default\ndescription: Delivery test\nphases:\n  - id: planning\n    title: Planning\n    profile: planner\n    guidelines: []\n    requiredCapabilities: []\n    work: []\n    checks: []\n    gate:\n      mode: manual\ndelivery:\n  mode: pull-request\n  mergeMethod: merge\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "policies", `${policyId}.yaml`),
    `schemaVersion: 1\nid: ${policyId}\napprovalMode: ${policyId === "autonomous" ? "automatic" : "manual"}\nmaxAttempts: 1\nriskOverrides: []\nallowDirectMerge: false\ndeliveryFailureAction: ${failureAction}\n`,
  );
  const service = new SwfService({
    serviceHome: home,
    hostingAdapter: adapter,
    commandRunner,
    deliveryPollIntervalMs: 0,
    projectTrust: async () => true,
  });
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Delivery project",
    root: projectRoot,
  });
  await createRun(projectRoot, { policyId });
  const store = new RunEventStore(join(projectRoot, ".swf-state"));
  await store.append(runId, {
    type: "run.transitioned",
    actor: { type: "service", id: "test" },
    context: {},
    data: { from: "pending", to: "running" },
  });
  await store.append(runId, {
    type: "run.transitioned",
    actor: { type: "service", id: "test" },
    context: {},
    data: { from: "running", to: "completed" },
  });
  const worktreePath = join(projectRoot, ".swf-state", "worktrees", runId);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(projectRoot, ".swf-state", "runs", runId, "runtime.json"),
    JSON.stringify({ branch: `swf/${runId}`, worktreePath }),
  );
  return { service, projectRoot };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-scoped SWF service", () => {
  it("exposes distinct responsibilities and prohibitions for every phase", async () => {
    const { service } = await setupPhaseContracts();
    const phases = [
      "planning",
      "building",
      "reviewing",
      "verifying",
      "releasing",
    ] as const;
    const explanations = await Promise.all(
      phases.map((phaseId) =>
        service.query({
          resource: "phase-explanation",
          projectId,
          runId,
          phaseId,
        }),
      ),
    );
    const byPhase = Object.fromEntries(
      phases.map((phaseId, index) => [phaseId, explanations[index]]),
    ) as Record<
      (typeof phases)[number],
      {
        explanation: {
          contract: { objective: string; responsibilities: string[] };
          prohibitedActions: string[];
          modelRoute?: { requestedTier?: string };
          tools: string[];
        };
      }
    >;

    expect(
      new Set(
        phases.map(
          (phaseId) => byPhase[phaseId].explanation.contract.objective,
        ),
      ).size,
    ).toBe(phases.length);
    expect(byPhase.planning.explanation.contract.responsibilities).toContain(
      "Validate OpenSpec artifacts strictly before completion.",
    );
    expect(byPhase.planning.explanation.prohibitedActions).toContain(
      "implement application code",
    );
    expect(byPhase.building.explanation.contract.responsibilities).toContain(
      "keep task checkboxes truthful",
    );
    expect(byPhase.building.explanation.prohibitedActions).toContain("merge");
    expect(
      byPhase.reviewing.explanation.contract.responsibilities[0],
    ).toContain("security");
    expect(byPhase.reviewing.explanation.prohibitedActions).toContain(
      "mutate application code",
    );
    expect(byPhase.verifying.explanation.contract.responsibilities).toContain(
      "map every task to implementation and evidence",
    );
    expect(byPhase.verifying.explanation.prohibitedActions).toContain(
      "override failed checks",
    );
    expect(byPhase.releasing.explanation.modelRoute).toBeUndefined();
    expect(byPhase.releasing.explanation.tools).not.toContain("agent");
    expect(byPhase.releasing.explanation.prohibitedActions).toContain("merge");
    await service.shutdown();
  });

  it("creates a durable run and executes Planning through the service-owned scheduler", async () => {
    const home = await temporaryDirectory("swf-service-entry-");
    const projectRoot = await temporaryDirectory("swf-service-entry-project-");
    const runner = new NodeCommandRunner();
    const git = async (args: string[]) => {
      const result = await runner.run("git", args, { cwd: projectRoot });
      if (result.code !== 0) throw new Error(result.stderr);
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "service@example.test"]);
    await git(["config", "user.name", "SWF service test"]);
    await mkdir(join(projectRoot, ".swf", "workflows"), { recursive: true });
    await mkdir(join(projectRoot, ".swf", "policies"), { recursive: true });
    await mkdir(join(projectRoot, ".swf", "profiles"), { recursive: true });
    await mkdir(join(projectRoot, ".swf", "guidelines"), { recursive: true });
    await mkdir(join(projectRoot, "openspec"), { recursive: true });
    await writeFile(
      join(projectRoot, ".swf", "config.yaml"),
      `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
    );
    await writeFile(
      join(projectRoot, ".swf", "workflows", "default.yaml"),
      `schemaVersion: 1\nid: default\ndescription: Service entry test\nphases:\n  - id: planning\n    title: Planning\n    profile: planner\n    guidelines: []\n    requiredCapabilities: [structured-events]\n    work:\n      - id: planning-agent\n        type: agent\n        profile: planner\n        options: {}\n      - id: planning-command\n        type: command\n        command: test -f openspec/changes/service-entry/proposal.md\n        options: {}\n    checks:\n      - id: planning-files\n        type: command\n        required: true\n        command: test -f openspec/changes/service-entry/tasks.md\n        options: {}\n    gate:\n      mode: manual\ndelivery:\n  mode: local-branch\n  mergeMethod: merge\n`,
    );
    await writeFile(
      join(projectRoot, ".swf", "policies", "manual.yaml"),
      `schemaVersion: 1\nid: manual\napprovalMode: manual\nmaxAttempts: 1\nriskOverrides: []\n`,
    );
    await writeFile(
      join(projectRoot, ".swf", "profiles", "planner.yaml"),
      `schemaVersion: 1\nid: planner\ndescription: Planning test profile\nharness: pi\nguidelines: []\ncapabilities: [structured-events]\noptions: {}\n`,
    );
    await writeFile(
      join(projectRoot, "openspec", "config.yaml"),
      "schema: spec-driven\n",
    );
    await writeFile(join(projectRoot, ".gitignore"), "/.swf-state/\n");
    await writeFile(join(projectRoot, "README.md"), "service entry test\n");
    await git(["add", "."]);
    await git(["commit", "-m", "initial project"]);

    const service = new SwfService({
      serviceHome: home,
      endpoint: "http://127.0.0.1:45002",
      projectTrust: async () => true,
      harnessAdapters: [new FakePlanningAdapter()],
      herdrClient: new HerdrClient(new SimulatedHerdrRunner()),
      commandRunner: runner,
      hostingAdapter: new FakeHostingAdapter(),
    });
    await service.start();
    await service.registerProject({
      projectId,
      displayName: "Service entry project",
      root: projectRoot,
    });
    const created = (await service.command({
      type: "new",
      projectId,
      changeName: "service-entry",
      description: "Create a service-backed Planning change",
    })) as {
      runId: string;
      status: string;
      projection: {
        stoppingPhaseId?: string;
        attention: Array<{ type: string; phaseId?: string }>;
        allowedActions: Array<{ type: string }>;
      };
    };
    expect(created.status).toBe("blocked");
    expect(created.projection).toMatchObject({
      stoppingPhaseId: "planning",
      attention: [{ type: "manual-approval", phaseId: "planning" }],
    });
    expect(created.projection.allowedActions.map(({ type }) => type)).toEqual([
      "inspect-evidence",
      "approve",
      "request-changes",
      "reject",
    ]);
    await expect(
      service.query({
        resource: "operator-projection",
        projectId,
        runId: created.runId,
      }),
    ).resolves.toEqual(created.projection);

    let loaded = (await service.query({
      resource: "run",
      projectId,
      runId: created.runId,
    })) as {
      state: {
        run: { status: string };
        phases: { planning: { status: string } };
        checkpoints: Record<
          string,
          { checkpointId: string; afterCommit: string }
        >;
      };
      runtime: { branch: string; worktreePath: string };
    };
    expect(loaded.state.run.status).toBe("blocked");
    expect(loaded.state.phases.planning.status).toBe("blocked");
    expect(Object.keys(loaded.state.checkpoints)).toHaveLength(0);
    const approved = (await service.command({
      type: "approve",
      projectId,
      runId: created.runId,
      phaseId: "planning",
      gateId: "planning-gate",
      actorId: "service-test-operator",
      reason: "Planning evidence is acceptable",
    })) as {
      approval: { actor: { id: string } };
      projection: {
        status: string;
        completedPhaseId?: string;
        attention: unknown[];
      };
    };
    expect(approved).toMatchObject({
      approval: { actor: { id: "service-test-operator" } },
      projection: {
        status: "paused",
        completedPhaseId: "planning",
        attention: [],
      },
    });
    loaded = (await service.query({
      resource: "run",
      projectId,
      runId: created.runId,
    })) as typeof loaded;
    expect(loaded.state.run.status).toBe("paused");
    expect(loaded.state.phases.planning.status).toBe("completed");
    expect(Object.keys(loaded.state.checkpoints)).toHaveLength(1);
    expect(loaded.runtime.branch).toBe(`swf/${created.runId}`);
    await expect(
      stat(
        join(
          loaded.runtime.worktreePath,
          "openspec",
          "changes",
          "service-entry",
          "proposal.md",
        ),
      ),
    ).resolves.toBeDefined();
    const stale = await service
      .command({
        type: "new",
        projectId,
        changeName: "service-entry",
        description: "duplicate",
      })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(OperatorCommandError);
    expect(stale).toMatchObject({
      classified: { category: "policy" },
      projection: { status: "paused", completedPhaseId: "planning" },
    });

    const checkpoint = Object.values(loaded.state.checkpoints)[0]!;
    await writeFile(join(loaded.runtime.worktreePath, "later.txt"), "later\n");
    const worktreeGit = async (args: string[]) => {
      const result = await runner.run("git", args, {
        cwd: loaded.runtime.worktreePath,
      });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await worktreeGit(["add", "."]);
    await worktreeGit(["commit", "-m", "later work"]);
    expect(await worktreeGit(["rev-parse", "HEAD"])).not.toBe(
      checkpoint.afterCommit,
    );
    const artifactIds = (
      (await service.query({
        resource: "artifacts",
        projectId,
        runId: created.runId,
      })) as Array<{ artifactId: string }>
    ).map(({ artifactId }) => artifactId);
    await service.command({
      type: "rollback",
      projectId,
      runId: created.runId,
      phaseId: "planning",
      checkpointId: checkpoint.checkpointId,
      invalidatedPhaseIds: [],
      invalidatedArtifactIds: artifactIds,
      authorized: true,
    });
    expect(await worktreeGit(["rev-parse", "HEAD"])).toBe(
      checkpoint.afterCommit,
    );
    await expect(
      stat(join(loaded.runtime.worktreePath, "later.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      service.command({
        type: "phase-run",
        projectId,
        changeName: "service-entry",
        phaseId: "planning",
      }),
    ).rejects.toThrow(/already completed.*explicit rerun/);
    await expect(
      service.command({
        type: "phase-rerun",
        projectId,
        changeName: "service-entry",
        phaseId: "planning",
      }),
    ).resolves.toMatchObject({ requiresAuthorization: true });
    await expect(
      service.command({
        type: "phase-rerun",
        projectId,
        changeName: "service-entry",
        phaseId: "planning",
        authorized: true,
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    await service.command({
      type: "approve",
      projectId,
      runId: created.runId,
      phaseId: "planning",
      gateId: "planning-gate",
      actorId: "service-test-operator",
      reason: "Rerun evidence is acceptable",
    });
    await expect(
      service.command({
        type: "check-run",
        projectId,
        changeName: "service-entry",
        checkId: "planning-files",
      }),
    ).resolves.toMatchObject({ checkId: "planning-files", status: "passed" });
    await service.shutdown();
  }, 15_000);

  it("owns a user scope with private endpoint metadata and credentials", async () => {
    const home = await temporaryDirectory("swf-service-");
    const service = new SwfService({
      serviceHome: home,
      endpoint: "http://127.0.0.1:45001",
    });
    const metadata = await service.start();
    const competing = new SwfService({
      serviceHome: home,
      endpoint: "http://127.0.0.1:45002",
    });

    expect(metadata.endpoint).toBe("http://127.0.0.1:45001");
    expect(metadata.credential).not.toHaveLength(0);
    expect((await stat(join(home, "service.json"))).mode & 0o777).toBe(0o600);
    await expect(competing.start()).rejects.toBeInstanceOf(
      ServiceAlreadyRunningError,
    );
    expect(() => service.authenticate("wrong-token")).toThrow(
      ServiceAuthenticationError,
    );
    expect(() => service.authenticate(metadata.credential)).not.toThrow();
    const reloaded = new SwfService({
      serviceHome: home,
      endpoint: metadata.endpoint,
      adoptSameProcessLock: true,
    });
    await expect(reloaded.start()).resolves.toMatchObject({
      serviceId: metadata.serviceId,
      credential: metadata.credential,
    });
    await reloaded.shutdown();
    await service.shutdown();
  });

  it("rejects non-loopback binding and untrusted project registration", async () => {
    expect(
      () =>
        new SwfService({
          serviceHome: "/tmp/not-used",
          endpoint: "http://0.0.0.0:45001",
        }),
    ).toThrow("loopback");
    const home = await temporaryDirectory("swf-service-trust-");
    const projectRoot = await temporaryDirectory("swf-untrusted-project-");
    await mkdir(join(projectRoot, ".git"));
    const service = new SwfService({ serviceHome: home });
    await service.start();
    await expect(
      service.registerProject({
        projectId,
        displayName: "Untrusted",
        root: projectRoot,
      }),
    ).rejects.toThrow("not trusted");
    expect(await readFile(join(home, "audit.jsonl"), "utf8")).toContain(
      '"outcome":"rejected"',
    );
    await service.shutdown();
  });

  it("reports installed harness adapter capabilities through the service", async () => {
    const home = await temporaryDirectory("swf-service-adapters-");
    const adapter: HarnessAdapter = {
      id: "codex",
      capabilities: {
        structuredEvents: true,
        modelSelection: true,
        toolSelection: false,
        cancellation: true,
        blockedInput: false,
        resume: true,
        usage: true,
      },
      availability: async () => ({ valid: true, errors: [] }),
      validate: async () => ({ valid: true, errors: [] }),
      launch: async () => {
        throw new Error("not used");
      },
      submit: async () => undefined,
      observe: async () => ({ status: "completed", structuredEvents: [] }),
      cancel: async () => undefined,
      collect: async () => ({
        status: "completed",
        transcript: "",
        usage: { quality: "unknown" },
      }),
    };
    const service = new SwfService({
      serviceHome: home,
      harnessAdapters: [adapter],
    });
    await service.start();
    await expect(service.query({ resource: "adapters" })).resolves.toEqual([
      {
        id: "codex",
        available: true,
        errors: [],
        capabilities: adapter.capabilities,
      },
    ]);
    await service.shutdown();
  });

  it("reconciles moved and unavailable project roots without copying project state", async () => {
    const { service, projectRoot } = await setup();
    const canonicalProjectRoot = await realpath(projectRoot);
    const movedRoot = `${projectRoot}-moved`;
    await rename(projectRoot, movedRoot);
    const moved = await service.registerProject({
      projectId,
      displayName: "Renamed project",
      root: movedRoot,
    });
    expect(moved.previousRoots).toContain(canonicalProjectRoot);
    await rm(movedRoot, { recursive: true });

    const [unavailable] = await service.reconcileProjects();
    expect(unavailable).toMatchObject({
      projectId,
      availability: "unavailable",
    });
    await service.shutdown();
  });

  it("provides authenticated project and run queries plus lifecycle commands", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);

    await expect(service.query({ resource: "projects" })).resolves.toHaveLength(
      1,
    );
    await expect(
      service.query({ resource: "runs", projectId }),
    ).resolves.toHaveLength(1);
    await expect(
      service.command({ type: "start", projectId, runId }),
    ).resolves.toMatchObject({ projection: { status: "running" } });
    await expect(
      service.command({ type: "pause", projectId, runId }),
    ).resolves.toMatchObject({ projection: { status: "paused" } });
    await expect(
      service.command({ type: "resume", projectId, runId }),
    ).resolves.toMatchObject({ projection: { status: "running" } });
    await expect(
      service.command({
        type: "reject",
        projectId,
        runId,
        phaseId: "planning",
        gateId: "planning-gate",
        actorId: "operator",
        reason: "needs changes",
      }),
    ).resolves.toMatchObject({
      approval: { decision: "rejected" },
      projection: { status: "running" },
    });
    await expect(
      service.command({
        type: "request-changes",
        projectId,
        runId,
        phaseId: "planning",
        gateId: "planning-gate",
        actorId: "operator",
        reason: "revise the plan",
      }),
    ).resolves.toMatchObject({
      approval: { decision: "request-changes" },
      projection: { status: "running" },
    });
    await expect(
      service.command({
        type: "approve",
        projectId,
        runId,
        phaseId: "planning",
        gateId: "planning-gate",
        actorId: "operator",
      }),
    ).resolves.toMatchObject({
      approval: { decision: "approved" },
      projection: { status: "running" },
    });
    await expect(
      service.command({
        type: "remediate",
        projectId,
        runId,
        phaseId: "planning",
        reason: "fix failing test",
      }),
    ).resolves.toMatchObject({ projection: { status: "running" } });
    await expect(
      service.query({ resource: "approvals", projectId, runId }),
    ).resolves.toHaveLength(3);
    await expect(
      service.command({ type: "cancel", projectId, runId }),
    ).resolves.toMatchObject({ projection: { status: "cancelled" } });

    const run = (await service.query({
      resource: "run",
      projectId,
      runId,
    })) as {
      state: {
        run: { status: string };
        phases: Record<string, { gate?: { status: string } }>;
        attempts: Record<string, unknown>;
      };
    };
    expect(run.state.run.status).toBe("cancelled");
    expect(run.state.phases.planning?.gate?.status).toBe("satisfied");
    expect(Object.keys(run.state.attempts)).toHaveLength(2);
    await expect(
      service.query({ resource: "costs", projectId, runId }),
    ).resolves.toEqual({ exactUsd: 0, estimatedUsd: 0, unknown: 0 });
    await service.shutdown();
  });

  it("rejects recursive orchestration from child phase invocations", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await expect(
      service.command({
        type: "start",
        projectId,
        runId,
        childContext: {
          childMode: true,
          allowNested: false,
          runId,
          phaseId: "planning",
          invocationId: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow(/Child phase invocations cannot mutate/);
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("pending");
    await service.shutdown();
  });

  it("enforces configured run budgets before starting work", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await writeFile(
      join(projectRoot, ".swf", "config.yaml"),
      `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\nbudgets:\n  run:\n    maxCostUsd: 0\n`,
    );
    await expect(
      service.command({ type: "start", projectId, runId }),
    ).rejects.toThrow("Budget prevents execution");
    await expect(
      service.query({ resource: "budgets", projectId, runId }),
    ).resolves.toEqual([
      expect.objectContaining({
        scope: "run",
        status: "exhausted",
        allowed: false,
      }),
    ]);
    await service.shutdown();
  });

  it("aggregates dashboard state and securely inspects and prunes retained output", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    const store = new RunEventStore(join(projectRoot, ".swf-state"));
    const invocationId = "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133";
    await store.append(runId, {
      type: "invocation.recorded",
      actor: { type: "service", id: "test" },
      context: { phaseId: "planning", invocationId },
      data: {
        invocation: {
          schemaVersion: 1,
          invocationId,
          runId,
          phaseId: "planning",
          harness: "pi",
          status: "completed",
          startedAt: "2026-04-02T12:00:00.000Z",
          endedAt: "2026-04-02T12:01:00.000Z",
          outputRef: "raw/invocations/test.log",
          cost: { amountUsd: 0.25, quality: "estimated" },
        },
      },
    });
    const rawDirectory = join(
      projectRoot,
      ".swf-state",
      "runs",
      runId,
      "raw",
      "invocations",
    );
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(join(rawDirectory, "test.log"), "retained output");

    await expect(
      service.query({ resource: "overview" }),
    ).resolves.toMatchObject({
      projects: [
        {
          projectId,
          activeRuns: 1,
          recentInvocations: [{ invocationId }],
          costs: { exactUsd: 0, estimatedUsd: 0.25, unknown: 0 },
        },
      ],
      totals: { projects: 1, activeRuns: 1, estimatedUsd: 0.25 },
    });
    await expect(
      service.query({
        resource: "output",
        projectId,
        runId,
        ref: "raw/invocations/test.log",
      }),
    ).resolves.toMatchObject({
      available: true,
      content: "retained output",
      truncated: false,
    });
    await expect(
      service.query({
        resource: "output",
        projectId,
        runId,
        ref: "../../projects.json",
      }),
    ).rejects.toThrow("inside the selected run");

    const preview = await service.previewPruning(projectId, { runId });
    expect(preview).toMatchObject({
      totalBytes: 15,
      candidates: [{ runId, ref: "raw/invocations/test.log" }],
    });
    await expect(
      service.confirmPruning(projectId, "wrong-token"),
    ).rejects.toThrow("fresh preview");
    await expect(
      service.confirmPruning(projectId, preview.confirmationId),
    ).resolves.toEqual({ pruned: 1, bytes: 15 });
    await expect(
      service.query({
        resource: "output",
        projectId,
        runId,
        ref: "raw/invocations/test.log",
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: "Output was pruned by retention policy or is unavailable",
    });
    await service.shutdown();
  });

  it("persists idempotent pull-request delivery while execution remains completed", async () => {
    const adapter = new FakeHostingAdapter();
    const { service, projectRoot } = await setupDelivery(adapter);
    await service.command({ type: "deliver", projectId, runId });
    await service.command({ type: "deliver", projectId, runId });
    const active = (await service.query({
      resource: "run",
      projectId,
      runId,
    })) as {
      state: {
        run: { status: string };
        deliveries: Record<string, { status: string; executionStatus: string }>;
      };
    };
    expect(active.state.run.status).toBe("completed");
    expect(Object.values(active.state.deliveries)).toEqual([
      expect.objectContaining({
        status: "awaiting-merge",
        executionStatus: "completed",
      }),
    ]);
    expect(adapter.upserts).toBe(2);

    adapter.release({
      state: "merged",
      checks: [{ name: "ci", status: "completed", conclusion: "success" }],
      reviews: [{ actor: "reviewer", state: "APPROVED" }],
    });
    await waitFor(async () => {
      const deliveries = (await service.query({
        resource: "delivery",
        projectId,
        runId,
      })) as Record<
        string,
        { status: string; cleanup?: { branchDeleted: boolean } }
      >;
      const delivery = Object.values(deliveries)[0];
      return (
        delivery?.status === "merged" &&
        delivery.cleanup?.branchDeleted === true
      );
    });
    expect(adapter.cleanups).toBe(1);
    const loaded = await new RunEventStore(
      join(projectRoot, ".swf-state"),
    ).load(runId);
    expect(
      loaded.events.filter(({ type }) => type === "delivery.recorded").length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      loaded.events.filter(({ type }) => type === "artifact.recorded").length,
    ).toBeGreaterThanOrEqual(4);
    await service.shutdown();
  });

  it("requires scoped delegation before autonomous pull-request merge", async () => {
    const adapter = new FakeHostingAdapter();
    const { service, projectRoot } = await setupDelivery(
      adapter,
      "escalate",
      "autonomous",
    );
    await expect(
      service.command({ type: "deliver", projectId, runId }),
    ).rejects.toThrow("recorded delegated authorization");
    expect(adapter.upserts).toBe(0);
    expect(adapter.autoMerges).toBe(0);

    await writeFile(
      join(projectRoot, ".swf-state", "runs", runId, "authorization.json"),
      JSON.stringify({
        authorizationId: "delivery-authorization",
        delegatedBy: { type: "user", id: "operator" },
        scope: "run",
        scopeId: runId,
        acknowledgedAt: new Date().toISOString(),
        configurationSource: "acceptance-test",
      }),
    );
    await service.command({ type: "deliver", projectId, runId });
    const deliveries = (await service.query({
      resource: "delivery",
      projectId,
      runId,
    })) as Record<string, { status: string; autoMergeRequested: boolean }>;
    expect(Object.values(deliveries)[0]).toMatchObject({
      status: "auto-merge-requested",
      autoMergeRequested: true,
    });
    expect(adapter.upserts).toBe(1);
    expect(adapter.autoMerges).toBe(1);
    await service.shutdown();
  });

  it("restores delivery monitoring after service restart", async () => {
    const firstAdapter = new FakeHostingAdapter();
    const { service } = await setupDelivery(firstAdapter);
    await service.command({ type: "deliver", projectId, runId });
    await service.shutdown();
    firstAdapter.release({ state: "open" });

    const recoveredAdapter = new FakeHostingAdapter();
    const recovered = new SwfService({
      serviceHome: service.serviceHome,
      hostingAdapter: recoveredAdapter,
      deliveryPollIntervalMs: 10,
      projectTrust: async () => true,
    });
    await recovered.start();
    recoveredAdapter.release({ state: "merged", mergeState: "MERGED" });
    await waitFor(async () => {
      const deliveries = (await recovered.query({
        resource: "delivery",
        projectId,
        runId,
      })) as Record<string, { cleanup?: { branchDeleted: boolean } }>;
      return Object.values(deliveries)[0]?.cleanup?.branchDeleted === true;
    });
    expect(recoveredAdapter.cleanups).toBe(1);
    await recovered.shutdown();
  });

  it("archives only after successful delivery and explicit opt-in", async () => {
    const adapter = new FakeHostingAdapter();
    const runner = new ArchiveCommandRunner();
    const { service } = await setupDelivery(
      adapter,
      "escalate",
      "manual",
      runner,
    );
    await service.command({ type: "deliver", projectId, runId });
    expect(runner.archiveCalls).toHaveLength(0);
    await expect(
      service.command({
        type: "archive-change",
        projectId,
        runId,
        authorized: false,
      }),
    ).rejects.toThrow("explicit authorization");

    adapter.release({ state: "merged", mergeState: "MERGED" });
    await waitFor(async () => {
      const deliveries = (await service.query({
        resource: "delivery",
        projectId,
        runId,
      })) as Record<
        string,
        { status: string; cleanup?: { branchDeleted: boolean } }
      >;
      const delivery = Object.values(deliveries)[0];
      return (
        delivery?.status === "merged" &&
        delivery.cleanup?.branchDeleted === true
      );
    });
    expect(runner.archiveCalls).toHaveLength(0);
    await expect(
      service.command({
        type: "archive-change",
        projectId,
        runId,
        authorized: true,
      }),
    ).resolves.toMatchObject({ archived: "add-user-auth" });
    expect(runner.archiveCalls).toEqual([
      ["archive", "change", "add-user-auth"],
    ]);
    await service.shutdown();
  });

  it("fails GitHub preflight before starting execution and preserves run state", async () => {
    class FailingPreflightAdapter extends FakeHostingAdapter {
      override async preflight() {
        return {
          valid: false,
          skipped: false,
          checks: [
            {
              id: "authentication" as const,
              status: "failed" as const,
              detail: "GitHub authentication is invalid",
            },
          ],
        };
      }
    }
    const adapter = new FailingPreflightAdapter();
    const { service } = await setupDelivery(adapter);
    await expect(
      service.command({ type: "start", projectId, runId }),
    ).rejects.toThrow("GitHub authentication is invalid");
    const run = (await service.query({
      resource: "run",
      projectId,
      runId,
    })) as {
      state: { run: { status: string } };
    };
    expect(run.state.run.status).toBe("completed");
    expect(adapter.upserts).toBe(0);
    await service.shutdown();
  });

  it("applies configured delivery remediation after hosted checks fail", async () => {
    const adapter = new FakeHostingAdapter();
    const { service, projectRoot } = await setupDelivery(adapter, "remediate");
    await service.command({ type: "deliver", projectId, runId });
    adapter.release({
      state: "open",
      checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
    });
    await waitFor(async () => {
      const run = (await service.query({
        resource: "run",
        projectId,
        runId,
      })) as {
        state: { run: { status: string }; attempts: Record<string, unknown> };
      };
      return (
        run.state.run.status === "pending" &&
        Object.keys(run.state.attempts).length === 1
      );
    });
    const delivery = (await service.query({
      resource: "delivery",
      projectId,
      runId,
    })) as Record<string, { status: string; failureReason?: string }>;
    expect(Object.values(delivery)[0]).toMatchObject({
      status: "checks-failed",
      failureReason: "Hosted checks failed",
    });
    expect(adapter.cleanups).toBe(0);
    await expect(
      stat(join(projectRoot, ".swf-state", "runs", runId, "runtime.json")),
    ).resolves.toBeDefined();
    await service.shutdown();
  });

  it("routes blocked agent input through the service to its recorded owned invocation", async () => {
    const { service } = await setup();
    const submitted: string[] = [];
    const adapter: HarnessAdapter = {
      id: "fake",
      capabilities: {
        structuredEvents: true,
        modelSelection: false,
        toolSelection: false,
        cancellation: true,
        blockedInput: true,
        resume: false,
        usage: false,
      },
      availability: async (): Promise<AdapterValidation> => ({
        valid: true,
        errors: [],
      }),
      validate: async (): Promise<AdapterValidation> => ({
        valid: true,
        errors: [],
      }),
      launch: async (): Promise<AdapterInvocation> => {
        throw new Error("not used");
      },
      submit: async (_invocation, response) => {
        submitted.push(response);
      },
      observe: async (): Promise<AdapterObservation> => ({
        status: "blocked",
        structuredEvents: [],
      }),
      cancel: async () => undefined,
      collect: async (): Promise<AdapterResult> => ({
        status: "completed",
        transcript: "",
        usage: { quality: "unknown" },
      }),
    };
    const invocation: AdapterInvocation = {
      invocationId: "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133",
      runId,
      phaseId: "planning",
      workUnitId: "agent",
      paneId: "p1",
      status: "blocked",
      startedAt: "2026-04-02T12:00:00.000Z",
    };
    service.reportBlockedAgent(adapter, invocation, {
      status: "blocked",
      blockedPrompt: "Choose",
      structuredEvents: [],
    });
    await expect(
      service.query({ resource: "blocked-inputs" }),
    ).resolves.toMatchObject([{ invocationId: invocation.invocationId }]);
    await service.command({
      type: "blocked-input",
      invocationId: invocation.invocationId,
      response: "Continue",
    });
    expect(submitted).toEqual(["Continue"]);
    await service.shutdown();
  });

  it("replays ordered events to reconnecting subscribers", async () => {
    const home = await temporaryDirectory("swf-service-");
    const service = new SwfService({
      serviceHome: home,
      projectTrust: async () => true,
    });
    await service.start();
    const first = service.subscribe();
    const started = await first[Symbol.asyncIterator]().next();
    expect(started.value?.type).toBe("service.started");

    const second = service.subscribe(started.value!.id);
    const secondIterator = second[Symbol.asyncIterator]();
    const projectRoot = await temporaryDirectory("swf-service-project-");
    await mkdir(join(projectRoot, ".git"));
    await service.registerProject({
      projectId,
      displayName: "Test project",
      root: projectRoot,
    });
    const update = await secondIterator.next();
    expect(update.value).toMatchObject({
      id: started.value!.id + 1,
      type: "project.registered",
      projectId,
    });
    first.close();
    second.close();
    expect((await secondIterator.next()).done).toBe(true);
    await service.shutdown();
  });

  it("drains safe work then pauses runs, and force shutdown interrupts only owned work", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await service.command({ type: "start", projectId, runId });
    let reachBoundary: () => void = () => undefined;
    const safeBoundary = new Promise<void>((resolve) => {
      reachBoundary = resolve;
    });
    service.registerActiveWork({
      projectId,
      runId,
      safeBoundary,
      interrupt: async () => undefined,
    });
    const graceful = service.shutdown();
    expect(service.status).toBe("draining");
    reachBoundary();
    await graceful;
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("paused");

    const forceHome = await temporaryDirectory("swf-service-force-");
    const forceService = new SwfService({
      serviceHome: forceHome,
      projectTrust: async () => true,
    });
    await forceService.start();
    await forceService.registerProject({
      projectId,
      displayName: "Test project",
      root: projectRoot,
    });
    await forceService.command({ type: "resume", projectId, runId });
    let interrupted = false;
    forceService.registerActiveWork({
      projectId,
      runId,
      safeBoundary: new Promise(() => undefined),
      interrupt: async () => {
        interrupted = true;
      },
    });
    await forceService.shutdown({ force: true });
    expect(interrupted).toBe(true);
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("paused");
  });

  it("reconciles active durable runs against recorded runtime resources", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await service.command({ type: "start", projectId, runId });
    await service.shutdown({ force: true });

    const recovered = new SwfService({
      serviceHome: service.serviceHome,
      projectTrust: async () => true,
    });
    await recovered.start();
    await recovered.command({ type: "resume", projectId, runId });
    await recovered.recover();
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("blocked");
    await recovered.shutdown();
  });
});
