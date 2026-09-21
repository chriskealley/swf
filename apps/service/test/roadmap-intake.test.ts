import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrClient,
  NodeCommandRunner,
  RoadmapIntakeJournal,
  RunEventStore,
  produceDefaultPlanningArtifacts,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type HarnessAdapter,
  type CommandOptions,
  type OpenRoadAdapter,
  type OpenRoadDiagnostic,
  type OpenRoadDoctorOutcome,
  type OpenRoadNextOutcome,
  type OpenRoadRoadmapItem,
  type OpenRoadStartOutcome,
  type ProcessResult,
} from "@swf/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  SwfService,
  type RoadmapIntakeResult,
} from "../src/server/swf-service.js";

const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const directories: string[] = [];
let endpointPort = 45100;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

class SimulatedRunner extends NodeCommandRunner {
  readonly openspecCalls: string[][] = [];

  override async run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<ProcessResult> {
    if (command === "openspec") {
      this.openspecCalls.push(args);
      if (args[0] === "new" && args[1] === "change" && options?.cwd) {
        await mkdir(join(options.cwd, "openspec", "changes", args[2]!), {
          recursive: true,
        });
      }
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (command === "herdr") {
      if (args[0] === "workspace" && args[1] === "create")
        return {
          code: 0,
          stdout: JSON.stringify({
            workspace: { workspace_id: "roadmap-workspace" },
          }),
          stderr: "",
        };
      if (args[0] === "worktree" && args[1] === "open")
        return {
          code: 0,
          stdout: JSON.stringify({
            worktree: { worktree_id: "roadmap-worktree" },
          }),
          stderr: "",
        };
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return super.run(command, args, options);
  }
}

/**
 * Models OpenRoad 0.2.0's observable behaviour: it alone decides eligibility,
 * `start` is idempotent, and an item already linked elsewhere is refused.
 */
class FakeOpenRoad implements OpenRoadAdapter {
  readonly nextCalls: string[] = [];
  readonly startCalls: Array<{ itemId: string; changeName: string }> = [];
  doctorOutcome: OpenRoadDoctorOutcome = {
    kind: "ready",
    summary: "Healthy: 2 roadmap item(s).",
  };
  /** Set to fail the next `start` call, simulating a crash before linking. */
  failNextStart?: Error;

  constructor(readonly items: OpenRoadRoadmapItem[] = []) {}

  async doctor(): Promise<OpenRoadDoctorOutcome> {
    return this.doctorOutcome;
  }

  async next(root: string): Promise<OpenRoadNextOutcome> {
    this.nextCalls.push(root);
    const item = this.items.find(
      (candidate) =>
        candidate.status === "ready" &&
        candidate.dependsOn.every(
          (id) =>
            this.items.find((other) => other.id === id)?.status === "done",
        ),
    );
    if (item)
      return {
        kind: "selected",
        item,
        result: { schemaVersion: 1, root, item, status: [] },
      };
    return {
      kind: "no-eligible-work",
      diagnostics: [
        {
          severity: "info",
          code: "no_ready_items",
          message: "No roadmap items are ready.",
        },
      ],
    };
  }

  async start(
    root: string,
    itemId: string,
    changeName: string,
  ): Promise<OpenRoadStartOutcome> {
    this.startCalls.push({ itemId, changeName });
    if (this.failNextStart) {
      const error = this.failNextStart;
      this.failNextStart = undefined;
      throw error;
    }
    const item = this.items.find((candidate) => candidate.id === itemId);
    const conflict = (code: string, message: string): OpenRoadStartOutcome => ({
      kind: "conflict",
      diagnostics: [{ severity: "error", code, message }],
    });
    if (!item) return conflict("item_not_found", `Unknown item: ${itemId}`);
    if (item.status === "active" && item.change === changeName)
      return {
        kind: "linked",
        item,
        changeName,
        changed: false,
        result: {
          schemaVersion: 1,
          root,
          item,
          change: {
            name: changeName,
            path: `${root}/openspec/changes/${changeName}`,
          },
          changed: false,
          status: [],
        },
      };
    if (item.status !== "ready")
      return conflict(
        "item_not_ready",
        `${itemId} is ${item.status}, not ready.`,
      );
    const owner = this.items.find(
      (candidate) => candidate.change === changeName,
    );
    if (owner)
      return conflict(
        "change_already_linked",
        `${changeName} is already linked to ${owner.id}`,
      );
    item.status = "active";
    item.change = changeName;
    return {
      kind: "linked",
      item,
      changeName,
      changed: true,
      result: {
        schemaVersion: 1,
        root,
        item,
        change: {
          name: changeName,
          path: `${root}/openspec/changes/${changeName}`,
        },
        changed: true,
        status: [],
      },
    };
  }
}

/** Produces the artifacts the Planning phase contract requires. */
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
    const changeName = request.prompt.match(
      /OpenSpec change ([a-z][a-z0-9-]*)/,
    )?.[1];
    if (!changeName)
      throw new Error("Planning prompt did not identify the change");
    await produceDefaultPlanningArtifacts({
      changeRoot: join(request.cwd, "openspec", "changes", changeName),
      changeName,
      planning: { kind: "description", description: "Roadmap-driven planning" },
    });
    return {
      invocationId: crypto.randomUUID(),
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: "roadmap-pane",
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
      transcript: "simulated roadmap planning complete",
      usage: { quality: "unknown" },
    };
  }
}

function readyItem(
  id: string,
  title: string,
  overrides: Partial<OpenRoadRoadmapItem> = {},
): OpenRoadRoadmapItem {
  return {
    id,
    title,
    status: "ready",
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

interface Harness {
  service: SwfService;
  projectRoot: string;
  openRoad: FakeOpenRoad;
  runner: SimulatedRunner;
  restart: () => Promise<SwfService>;
}

async function setup(
  items: OpenRoadRoadmapItem[],
  options: { openRoad?: FakeOpenRoad } = {},
): Promise<Harness> {
  const home = await temporaryDirectory("swf-roadmap-home-");
  const projectRoot = await temporaryDirectory("swf-roadmap-project-");
  const runner = new SimulatedRunner();
  const git = async (args: string[]) => {
    const result = await new NodeCommandRunner().run("git", args, {
      cwd: projectRoot,
    });
    if (result.code !== 0) throw new Error(result.stderr);
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "roadmap@example.test"]);
  await git(["config", "user.name", "SWF roadmap test"]);
  for (const directory of ["workflows", "policies", "profiles", "guidelines"])
    await mkdir(join(projectRoot, ".swf", directory), { recursive: true });
  await mkdir(join(projectRoot, "openspec"), { recursive: true });
  await writeFile(
    join(projectRoot, ".swf", "config.yaml"),
    `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "workflows", "default.yaml"),
    "schemaVersion: 1\nid: default\ndescription: Roadmap intake test\nphases:\n" +
      "  - id: planning\n    title: Planning\n    profile: planner\n    guidelines: []\n    requiredCapabilities: [structured-events]\n    work:\n      - id: planning-agent\n        type: agent\n        profile: planner\n        options: {}\n    checks: []\n    gate:\n      mode: automatic\n" +
      "  - id: building\n    title: Building\n    profile: planner\n    guidelines: []\n    requiredCapabilities: []\n    work: []\n    checks: []\n    gate:\n      mode: manual\n" +
      "delivery:\n  mode: local-branch\n  mergeMethod: merge\n",
  );
  await writeFile(
    join(projectRoot, ".swf", "policies", "manual.yaml"),
    "schemaVersion: 1\nid: manual\napprovalMode: manual\nmaxAttempts: 1\nriskOverrides: []\n",
  );
  await writeFile(
    join(projectRoot, ".swf", "profiles", "planner.yaml"),
    "schemaVersion: 1\nid: planner\ndescription: Roadmap test profile\nharness: pi\nguidelines: []\ncapabilities: [structured-events]\noptions: {}\n",
  );
  await writeFile(
    join(projectRoot, "openspec", "config.yaml"),
    "schema: spec-driven\n",
  );
  await writeFile(join(projectRoot, ".gitignore"), "/.swf-state/\n");
  await writeFile(join(projectRoot, "README.md"), "roadmap intake test\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial project"]);

  const openRoad = options.openRoad ?? new FakeOpenRoad(items);
  const build = () =>
    new SwfService({
      serviceHome: home,
      endpoint: `http://127.0.0.1:${(endpointPort += 1)}`,
      projectTrust: async () => true,
      harnessAdapters: [new FakePlanningAdapter()],
      herdrClient: new HerdrClient(runner),
      commandRunner: runner,
      openRoadAdapter: openRoad,
      adoptSameProcessLock: false,
    });
  let service = build();
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Roadmap project",
    root: projectRoot,
  });
  return {
    service,
    projectRoot,
    openRoad,
    runner,
    restart: async () => {
      await service.shutdown();
      service = build();
      await service.start();
      await service.registerProject({
        projectId,
        displayName: "Roadmap project",
        root: projectRoot,
      });
      return service;
    },
  };
}

async function intake(
  service: SwfService,
  type: "roadmap-new" | "roadmap-run" | "roadmap-reconcile" = "roadmap-new",
): Promise<RoadmapIntakeResult> {
  return (await service.command({ type, projectId })) as RoadmapIntakeResult;
}

async function runCount(projectRoot: string): Promise<number> {
  const bindings = JSON.parse(
    await readFile(
      join(projectRoot, ".swf-state", "run-bindings.json"),
      "utf8",
    ).catch(() => '{"byChangeIdentity":{}}'),
  ) as { byChangeIdentity: Record<string, string> };
  return Object.keys(bindings.byChangeIdentity).length;
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("roadmap intake saga", () => {
  it("starts the item OpenRoad selected and stops after Planning", async () => {
    const harness = await setup([
      readyItem("RM-001", "Adopt roadmap intake", { priority: 1 }),
    ]);
    const result = await intake(harness.service);
    expect(result).toMatchObject({
      schemaVersion: 1,
      intake: "selected",
      mode: "planning-only",
      itemId: "RM-001",
      changeName: "adopt-roadmap-intake",
      status: "paused",
    });
    expect(result.runId).toBeDefined();
    expect(harness.openRoad.startCalls).toEqual([
      { itemId: "RM-001", changeName: "adopt-roadmap-intake" },
    ]);

    const store = new RunEventStore(join(harness.projectRoot, ".swf-state"));
    const run = await store.readRun(result.runId!);
    expect(run.roadmap).toMatchObject({
      source: "openroad",
      itemId: "RM-001",
      operationId: result.operationId,
    });
    const loaded = await store.load(result.runId!);
    expect(loaded.state.phases.planning?.status).toBe("completed");
    expect(loaded.state.phases.building?.status ?? "pending").toBe("pending");
    expect(harness.runner.openspecCalls[0]).toEqual([
      "new",
      "change",
      "adopt-roadmap-intake",
      "--json",
    ]);
    await harness.service.shutdown();
  });

  it("continues past Planning in automatic mode", async () => {
    const harness = await setup([readyItem("RM-002", "Automatic progression")]);
    const result = await intake(harness.service, "roadmap-run");

    expect(result).toMatchObject({
      intake: "selected",
      mode: "automatic",
      itemId: "RM-002",
      status: "blocked",
    });
    const loaded = await new RunEventStore(
      join(harness.projectRoot, ".swf-state"),
    ).load(result.runId!);
    expect(loaded.state.phases.planning?.status).toBe("completed");
    expect(loaded.state.phases.building?.status).toBe("blocked");
    await harness.service.shutdown();
  });

  it("starts the returned item even while unrelated work is active", async () => {
    const harness = await setup([
      readyItem("RM-003", "Already active", {
        status: "active",
        change: "already-active",
      }),
      readyItem("RM-004", "Blocked elsewhere", {
        status: "ready",
        workState: "blocked",
      }),
    ]);
    const result = await intake(harness.service);
    expect(result).toMatchObject({ intake: "selected", itemId: "RM-004" });
    expect(result.conflicts).toBeUndefined();
    await harness.service.shutdown();
  });

  it("creates nothing when no roadmap item is eligible", async () => {
    const harness = await setup([
      readyItem("RM-005", "Waiting", { status: "planned" }),
    ]);
    const result = await intake(harness.service);

    expect(result).toMatchObject({ intake: "no-eligible-work" });
    expect(result.runId).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("no_ready_items");
    expect(await runCount(harness.projectRoot)).toBe(0);
    expect(harness.openRoad.startCalls).toHaveLength(0);
    await harness.service.shutdown();
  });

  it("creates nothing when the roadmap is invalid", async () => {
    const harness = await setup([readyItem("RM-006", "Unreachable")]);
    const diagnostics: OpenRoadDiagnostic[] = [
      {
        severity: "error",
        code: "roadmap_invalid",
        message: "RM-006: duplicate id",
      },
    ];
    harness.openRoad.doctorOutcome = { kind: "invalid-roadmap", diagnostics };
    const result = await intake(harness.service);

    expect(result).toMatchObject({ intake: "invalid-roadmap" });
    expect(result.diagnostics).toEqual(diagnostics);
    expect(await runCount(harness.projectRoot)).toBe(0);
    expect(harness.openRoad.nextCalls).toHaveLength(0);
    await harness.service.shutdown();
  });

  it("resumes the same association when intake is repeated", async () => {
    const harness = await setup([readyItem("RM-007", "Repeat intake")]);
    const first = await intake(harness.service);
    const second = await intake(harness.service);

    expect(second).toMatchObject({
      intake: "resumed",
      itemId: "RM-007",
      changeName: first.changeName,
      runId: first.runId,
    });
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect(
      (
        await new RoadmapIntakeJournal(
          join(harness.projectRoot, ".swf-state"),
        ).read()
      ).records,
    ).toHaveLength(1);
    await harness.service.shutdown();
  });
});

describe("roadmap intake partial-start recovery", () => {
  it("links the roadmap after a crash between run creation and activation", async () => {
    const harness = await setup([readyItem("RM-010", "Interrupted linking")]);
    harness.openRoad.failNextStart = new Error("openroad was interrupted");
    await expect(intake(harness.service)).rejects.toThrow();

    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const journal = new RoadmapIntakeJournal(stateDirectory);
    const pending = await journal.incomplete();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      itemId: "RM-010",
      step: "run-created",
    });
    expect(await runCount(harness.projectRoot)).toBe(1);

    const recovered = await intake(harness.service);
    expect(recovered).toMatchObject({
      intake: "recovered",
      itemId: "RM-010",
      runId: pending[0]!.runId,
    });
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect(await journal.incomplete()).toHaveLength(0);
    expect(harness.openRoad.items[0]).toMatchObject({
      status: "active",
      change: recovered.changeName,
    });
    await harness.service.shutdown();
  });

  it("creates the missing run when the roadmap link already exists", async () => {
    const harness = await setup([readyItem("RM-011", "Link without run")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    // OpenRoad activated the item, but SWF was interrupted before its run
    // existed: the durable intent is the only evidence that ties them together.
    harness.openRoad.items[0]!.status = "active";
    harness.openRoad.items[0]!.change = "link-without-run";
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: crypto.randomUUID(),
      itemId: "RM-011",
      itemTitle: "Link without run",
      changeName: "link-without-run",
      mode: "planning-only",
      step: "intent-recorded",
    });

    const result = await intake(harness.service);
    expect(result).toMatchObject({
      intake: "recovered",
      itemId: "RM-011",
      changeName: "link-without-run",
      status: "paused",
    });
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect(
      (await new RunEventStore(stateDirectory).readRun(result.runId!)).roadmap
        ?.itemId,
    ).toBe("RM-011");
    // Selection never ran: the unfinished intent was settled first.
    expect(harness.openRoad.nextCalls).toHaveLength(0);
    await harness.service.shutdown();
  });

  it("converges on one item, change, and run when a completion write is lost", async () => {
    const harness = await setup([readyItem("RM-012", "Lost completion")]);
    const first = await intake(harness.service);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const journal = new RoadmapIntakeJournal(stateDirectory);
    const record = (await journal.read()).records[0]!;
    // Simulate the crash by rewriting the final step out of the journal.
    await writeFile(
      join(stateDirectory, "roadmap-intake.json"),
      `${JSON.stringify(
        { schemaVersion: 1, records: [{ ...record, step: "roadmap-linked" }] },
        null,
        2,
      )}\n`,
    );

    const recovered = await intake(harness.service);
    expect(recovered).toMatchObject({
      intake: "recovered",
      itemId: "RM-012",
      changeName: first.changeName,
      runId: first.runId,
    });
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect((await journal.read()).records).toHaveLength(1);
    expect(await journal.incomplete()).toHaveLength(0);
    await harness.service.shutdown();
  });

  it("settles an incomplete intent during service recovery", async () => {
    const harness = await setup([readyItem("RM-013", "Recovered at startup")]);
    harness.openRoad.failNextStart = new Error("openroad was interrupted");
    await expect(intake(harness.service)).rejects.toThrow();

    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const restarted = await harness.restart();
    const journal = new RoadmapIntakeJournal(stateDirectory);
    expect(await journal.incomplete()).toHaveLength(0);
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect(harness.openRoad.items[0]).toMatchObject({ status: "active" });
    await restarted.shutdown();
  });
});

describe("roadmap intake conflicts", () => {
  it("reports a change already bound to another item without reassigning", async () => {
    const harness = await setup([
      readyItem("RM-020", "Shared title"),
      readyItem("RM-021", "Shared title"),
    ]);
    const first = await intake(harness.service);
    expect(first).toMatchObject({ intake: "selected", itemId: "RM-020" });

    // The second item derives the same preferred name, so the roadmap-ID
    // fallback keeps both associations distinct rather than colliding.
    const second = await intake(harness.service);
    expect(second).toMatchObject({
      intake: "selected",
      itemId: "RM-021",
      changeName: "shared-title-rm-021",
    });
    expect(first.changeName).toBe("shared-title");
    expect(await runCount(harness.projectRoot)).toBe(2);
    await harness.service.shutdown();
  });

  it("refuses to reuse a direct-entry run and leaves every identity unchanged", async () => {
    const harness = await setup([readyItem("RM-022", "Direct entry clash")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const store = new RunEventStore(stateDirectory);
    const direct = await store.create({
      projectId,
      changeName: "direct-entry-clash",
      changeIdentity: "openspec/changes/direct-entry-clash",
      workflowId: "default",
      description: "Created by direct entry",
      phaseIds: ["planning"],
    });
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: crypto.randomUUID(),
      itemId: "RM-022",
      itemTitle: "Direct entry clash",
      changeName: "direct-entry-clash",
      mode: "planning-only",
      step: "intent-recorded",
    });

    const result = await intake(harness.service);
    expect(result.intake).toBe("conflict");
    expect(result.conflicts?.[0]).toMatchObject({
      itemId: "RM-022",
      changeName: "direct-entry-clash",
      observedRunId: direct.runId,
    });
    // Nothing was reassigned: the roadmap, the change, and the run are as found.
    expect(harness.openRoad.items[0]!.status).toBe("ready");
    expect(harness.openRoad.startCalls).toHaveLength(0);
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect((await store.readRun(direct.runId)).roadmap).toBeUndefined();
    await harness.service.shutdown();
  });

  it("reports OpenRoad's own linkage conflict without a second run", async () => {
    const harness = await setup([readyItem("RM-023", "Externally linked")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: crypto.randomUUID(),
      itemId: "RM-023",
      itemTitle: "Externally linked",
      changeName: "externally-linked",
      mode: "planning-only",
      step: "intent-recorded",
    });
    // Another roadmap item took the change name after the intent was recorded.
    harness.openRoad.items.push(
      readyItem("RM-024", "Other", {
        status: "active",
        change: "externally-linked",
      }),
    );

    const result = await intake(harness.service);
    expect(result.intake).toBe("conflict");
    expect(result.diagnostics[0]?.code).toBe("change_already_linked");
    expect(result.conflicts?.[0]).toMatchObject({ itemId: "RM-023" });
    expect(harness.openRoad.items[0]!.status).toBe("ready");
    await harness.service.shutdown();
  });

  it("leaves an ambiguous identity blocked instead of guessing", async () => {
    const harness = await setup([readyItem("RM-025", "Ambiguous run")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const store = new RunEventStore(stateDirectory);
    const other = await store.create({
      projectId,
      changeName: "ambiguous-run",
      changeIdentity: "openspec/changes/ambiguous-run",
      workflowId: "default",
      description: "Bound to a different roadmap item",
      phaseIds: ["planning"],
      roadmap: {
        source: "openroad",
        itemId: "RM-099",
        operationId: crypto.randomUUID(),
        linkedAt: new Date().toISOString(),
      },
    });
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: crypto.randomUUID(),
      itemId: "RM-025",
      itemTitle: "Ambiguous run",
      changeName: "ambiguous-run",
      mode: "planning-only",
      step: "intent-recorded",
    });

    const result = await intake(harness.service, "roadmap-reconcile");
    expect(result.intake).toBe("conflict");
    expect(result.conflicts?.[0]).toMatchObject({
      itemId: "RM-025",
      observedItemId: "RM-099",
      observedRunId: other.runId,
    });
    expect(await runCount(harness.projectRoot)).toBe(1);
    expect(harness.openRoad.startCalls).toHaveLength(0);
    await harness.service.shutdown();
  });
});

describe("direct entry stays available", () => {
  it("never consults OpenRoad for an explicit change identity", async () => {
    const harness = await setup([readyItem("RM-030", "Unused roadmap item")]);
    const created = (await harness.service.command({
      type: "new",
      projectId,
      changeName: "direct-change",
      description: "Started without the roadmap",
    })) as { runId: string };

    expect(harness.openRoad.nextCalls).toHaveLength(0);
    expect(harness.openRoad.startCalls).toHaveLength(0);
    expect(
      (
        await new RunEventStore(
          join(harness.projectRoot, ".swf-state"),
        ).readRun(created.runId)
      ).roadmap,
    ).toBeUndefined();
    expect(harness.openRoad.items[0]!.status).toBe("ready");
    await harness.service.shutdown();
  });
});

describe("roadmap intake machine-readable contract", () => {
  /** No envelope may carry interactive prose in place of machine-readable state. */
  function assertEnvelope(result: RoadmapIntakeResult): void {
    expect(result.schemaVersion).toBe(1);
    expect([
      "selected",
      "resumed",
      "recovered",
      "no-eligible-work",
      "invalid-roadmap",
      "conflict",
    ]).toContain(result.intake);
    expect(["planning-only", "automatic"]).toContain(result.mode);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    if (result.runId) expect(result.status).toBeDefined();
  }

  it("returns identities and a run projection on a successful selection", async () => {
    const harness = await setup([readyItem("RM-040", "Contract selection")]);
    const result = await intake(harness.service, "roadmap-run");
    assertEnvelope(result);

    expect(result).toMatchObject({
      intake: "selected",
      itemId: "RM-040",
      itemTitle: "Contract selection",
      changeName: "contract-selection",
    });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.status).toBe("blocked");
    expect(result.nextAction).toBe("swf status contract-selection");

    // Every client reads the same service-owned projection.
    const projection = (result as unknown as { projection?: unknown })
      .projection;
    expect(projection).toEqual(
      await harness.service.query({
        resource: "operator-projection",
        projectId,
        runId: result.runId!,
      }),
    );
    expect(projection).toMatchObject({
      changeName: "contract-selection",
      runId: result.runId,
    });
    await harness.service.shutdown();
  });

  it("identifies each known identity on a conflict without interactive text", async () => {
    const harness = await setup([readyItem("RM-041", "Contract conflict")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const store = new RunEventStore(stateDirectory);
    const other = await store.create({
      projectId,
      changeName: "contract-conflict",
      changeIdentity: "openspec/changes/contract-conflict",
      workflowId: "default",
      description: "Bound elsewhere",
      phaseIds: ["planning"],
      roadmap: {
        source: "openroad",
        itemId: "RM-098",
        operationId: crypto.randomUUID(),
        linkedAt: new Date().toISOString(),
      },
    });
    await new RoadmapIntakeJournal(stateDirectory).record({
      operationId: crypto.randomUUID(),
      itemId: "RM-041",
      itemTitle: "Contract conflict",
      changeName: "contract-conflict",
      mode: "planning-only",
      step: "intent-recorded",
    });

    const result = await intake(harness.service);
    assertEnvelope(result);
    expect(result.intake).toBe("conflict");
    expect(result.conflicts?.[0]).toMatchObject({
      itemId: "RM-041",
      changeName: "contract-conflict",
      observedItemId: "RM-098",
      observedRunId: other.runId,
    });
    expect(JSON.stringify(result)).not.toMatch(/\?$|Do you|Press |\[y\/n\]/i);
    await harness.service.shutdown();
  });

  it("returns a versioned envelope for every non-success outcome", async () => {
    const empty = await setup([]);
    const exhausted = await intake(empty.service);
    assertEnvelope(exhausted);
    expect(exhausted).toMatchObject({ intake: "no-eligible-work" });
    expect(exhausted.runId).toBeUndefined();
    await empty.service.shutdown();

    const broken = await setup([readyItem("RM-042", "Broken roadmap")]);
    broken.openRoad.doctorOutcome = {
      kind: "invalid-roadmap",
      diagnostics: [
        { severity: "error", code: "roadmap_invalid", message: "bad heading" },
      ],
    };
    const invalid = await intake(broken.service);
    assertEnvelope(invalid);
    expect(invalid).toMatchObject({
      intake: "invalid-roadmap",
      nextAction: "openroad doctor",
    });
    await broken.service.shutdown();
  });

  it("reports resumed and recovered with the same identities as the original", async () => {
    const harness = await setup([readyItem("RM-043", "Repeat identities")]);
    const first = await intake(harness.service);
    assertEnvelope(first);

    const resumed = await intake(harness.service);
    assertEnvelope(resumed);
    expect(resumed).toMatchObject({
      intake: "resumed",
      itemId: first.itemId,
      changeName: first.changeName,
      runId: first.runId,
      operationId: first.operationId,
    });

    const stateDirectory = join(harness.projectRoot, ".swf-state");
    const journal = new RoadmapIntakeJournal(stateDirectory);
    const record = (await journal.read()).records[0]!;
    await writeFile(
      join(stateDirectory, "roadmap-intake.json"),
      `${JSON.stringify(
        { schemaVersion: 1, records: [{ ...record, step: "run-created" }] },
        null,
        2,
      )}\n`,
    );
    const recovered = await intake(harness.service);
    assertEnvelope(recovered);
    expect(recovered).toMatchObject({
      intake: "recovered",
      itemId: first.itemId,
      changeName: first.changeName,
      runId: first.runId,
    });
    await harness.service.shutdown();
  });
});

describe("roadmap intake state migration through the service", () => {
  it("discovers and applies the migration via the migrate command", async () => {
    const harness = await setup([readyItem("RM-090", "Migrated project")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "state-version.json"),
      `${JSON.stringify({ schemaVersion: 1, stateVersion: 1 }, null, 2)}\n`,
    );

    const preview = (await harness.service.command({
      type: "migrate",
      projectId,
      dryRun: true,
    })) as { applied: boolean; plan: { from: number; to: number } };
    expect(preview.applied).toBe(false);
    expect(preview.plan).toMatchObject({ from: 1, to: 2 });
    expect(preview.plan).toHaveProperty("migrations");
    expect(
      await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8").catch(
        () => undefined,
      ),
    ).toBeUndefined();

    const applied = (await harness.service.command({
      type: "migrate",
      projectId,
      dryRun: false,
    })) as { applied: boolean; backupId?: string };
    expect(applied.applied).toBe(true);
    expect(applied.backupId).toBeDefined();
    expect(
      JSON.parse(
        await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8"),
      ),
    ).toEqual({ schemaVersion: 1, records: [] });
    expect(
      JSON.parse(
        await readFile(join(stateDirectory, "state-version.json"), "utf8"),
      ),
    ).toMatchObject({ stateVersion: 2 });
    await harness.service.shutdown();
  });

  it("preserves existing run bindings across the migration", async () => {
    const harness = await setup([readyItem("RM-091", "Bindings preserved")]);
    const first = await intake(harness.service);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    await writeFile(
      join(stateDirectory, "state-version.json"),
      `${JSON.stringify({ schemaVersion: 1, stateVersion: 1 }, null, 2)}\n`,
    );
    const bindings = await readFile(
      join(stateDirectory, "run-bindings.json"),
      "utf8",
    );

    await harness.service.command({
      type: "migrate",
      projectId,
      dryRun: false,
    });
    expect(
      await readFile(join(stateDirectory, "run-bindings.json"), "utf8"),
    ).toBe(bindings);
    expect(
      (await new RunEventStore(stateDirectory).readRun(first.runId!)).roadmap
        ?.itemId,
    ).toBe("RM-091");
    // An existing journal is never replaced by the empty one.
    expect(
      (await new RoadmapIntakeJournal(stateDirectory).read()).records,
    ).toHaveLength(1);
    await harness.service.shutdown();
  });

  it("rolls the migration back through the service", async () => {
    const harness = await setup([readyItem("RM-092", "Rolled back")]);
    const stateDirectory = join(harness.projectRoot, ".swf-state");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "state-version.json"),
      `${JSON.stringify({ schemaVersion: 1, stateVersion: 1 }, null, 2)}\n`,
    );
    const applied = (await harness.service.command({
      type: "migrate",
      projectId,
      dryRun: false,
    })) as { backupId?: string };

    const rolledBack = (await harness.service.command({
      type: "migrate",
      projectId,
      rollbackBackupId: applied.backupId,
    })) as { rolledBack?: string };
    expect(rolledBack.rolledBack).toBe(applied.backupId);
    expect(
      await readFile(join(stateDirectory, "roadmap-intake.json"), "utf8").catch(
        () => undefined,
      ),
    ).toBeUndefined();
    await harness.service.shutdown();
  });
});

describe("roadmap intake rejects drifted OpenRoad identities", () => {
  it("reports a conflict when start links an item other than the requested one", async () => {
    const drifting = new FakeOpenRoad([readyItem("RM-095", "Drifting link")]);
    const original = drifting.start.bind(drifting);
    drifting.start = async (root, itemId, changeName) => {
      const outcome = await original(root, itemId, changeName);
      return outcome.kind === "linked"
        ? { ...outcome, item: { ...outcome.item, id: "RM-999" } }
        : outcome;
    };
    const harness = await setup([], { openRoad: drifting });

    const result = await intake(harness.service);
    expect(result.intake).toBe("conflict");
    expect(result.conflicts?.[0]).toMatchObject({
      itemId: "RM-095",
      observedItemId: "RM-999",
    });
    // The record is never completed for work SWF did not ask to link.
    expect(
      await new RoadmapIntakeJournal(
        join(harness.projectRoot, ".swf-state"),
      ).incomplete(),
    ).toHaveLength(1);
    await harness.service.shutdown();
  });
});
