import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  HerdrClient,
  NodeCommandRunner,
  ProcessOpenRoadAdapter,
  RoadmapIntakeJournal,
  RunEventStore,
  produceDefaultPlanningArtifacts,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type CommandOptions,
  type HarnessAdapter,
  type OpenRoadAdapter,
  type OpenRoadStartOutcome,
  type ProcessResult,
} from "../packages/core/src/index.ts";
import {
  SwfService,
  type RoadmapIntakeResult,
} from "../apps/service/src/server/swf-service.ts";

const execute = promisify(execFile);
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const directories: string[] = [];
let endpointPort = 45300;

/**
 * These fixtures drive the real OpenRoad CLI so the integration is verified
 * against its actual documented output, not a restatement of it.
 */
const openRoadAvailable = await execute("openroad", ["--help"]).then(
  () => true,
  () => false,
);

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function roadmap(
  items: Array<{
    id: string;
    title: string;
    status: string;
    priority: number;
    workState?: string;
    change?: string;
    dependsOn?: string[];
  }>,
): string {
  return [
    "# OpenRoad",
    "",
    "## Items",
    "",
    ...items.flatMap((item) => [
      `### ${item.id} — ${item.title}`,
      "",
      `**Status:** ${item.status}`,
      ...(item.workState ? [`**Work state:** ${item.workState}`] : []),
      `**Priority:** ${item.priority}`,
      ...(item.change ? [`**Change:** ${item.change}`] : []),
      `**Depends on:** ${(item.dependsOn ?? []).join(", ")}`,
      "",
      `Outcome for ${item.id}.`,
      "",
    ]),
  ].join("\n");
}

class SimulatedHerdrRunner extends NodeCommandRunner {
  override async run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<ProcessResult> {
    if (command === "herdr") {
      if (args[0] === "workspace" && args[1] === "create")
        return {
          code: 0,
          stdout: JSON.stringify({
            workspace: { workspace_id: "e2e-roadmap-workspace" },
          }),
          stderr: "",
        };
      if (args[0] === "worktree" && args[1] === "open")
        return {
          code: 0,
          stdout: JSON.stringify({
            worktree: { worktree_id: "e2e-roadmap-worktree" },
          }),
          stderr: "",
        };
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return super.run(command, args, options);
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
      paneId: "e2e-roadmap-pane",
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
      transcript: "planning complete",
      usage: { quality: "unknown" },
    };
  }
}

/** Fails `start` once, leaving a run that OpenRoad has not yet activated. */
class InterruptingOpenRoad implements OpenRoadAdapter {
  private failed = false;
  constructor(private readonly inner: OpenRoadAdapter) {}
  doctor = (root: string) => this.inner.doctor(root);
  next = (root: string) => this.inner.next(root);
  async start(
    root: string,
    itemId: string,
    changeName: string,
  ): Promise<OpenRoadStartOutcome> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("openroad was interrupted before linking");
    }
    return this.inner.start(root, itemId, changeName);
  }
}

interface Harness {
  service: SwfService;
  projectRoot: string;
  roadmapPath: string;
  intake: (
    type?: "roadmap-new" | "roadmap-run" | "roadmap-reconcile",
  ) => Promise<RoadmapIntakeResult>;
}

async function setup(
  source: string,
  options: { wrapOpenRoad?: (inner: OpenRoadAdapter) => OpenRoadAdapter } = {},
): Promise<Harness> {
  const home = await temporaryDirectory("swf-e2e-roadmap-home-");
  const projectRoot = await temporaryDirectory("swf-e2e-roadmap-project-");
  const runner = new SimulatedHerdrRunner();
  const git = async (args: string[]) => {
    const result = await new NodeCommandRunner().run("git", args, {
      cwd: projectRoot,
    });
    if (result.code !== 0) throw new Error(result.stderr);
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "roadmap@example.test"]);
  await git(["config", "user.name", "SWF roadmap e2e"]);
  for (const directory of ["workflows", "policies", "profiles", "guidelines"])
    await mkdir(join(projectRoot, ".swf", directory), { recursive: true });
  await mkdir(join(projectRoot, "openspec", "changes"), { recursive: true });
  await mkdir(join(projectRoot, "openspec", "specs"), { recursive: true });
  await writeFile(
    join(projectRoot, ".swf", "config.yaml"),
    `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
  );
  await writeFile(
    join(projectRoot, ".swf", "workflows", "default.yaml"),
    "schemaVersion: 1\nid: default\ndescription: Roadmap e2e\nphases:\n" +
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
    "schemaVersion: 1\nid: planner\ndescription: Roadmap e2e profile\nharness: pi\nguidelines: []\ncapabilities: [structured-events]\noptions: {}\n",
  );
  await writeFile(
    join(projectRoot, "openspec", "config.yaml"),
    "schema: spec-driven\n",
  );
  await execute("openroad", ["init", "--root", projectRoot]);
  const roadmapPath = join(projectRoot, "openspec", "roadmap.md");
  await writeFile(roadmapPath, source);
  await writeFile(join(projectRoot, ".gitignore"), "/.swf-state/\n");
  await writeFile(join(projectRoot, "README.md"), "roadmap e2e\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial project"]);

  const inner = new ProcessOpenRoadAdapter(new NodeCommandRunner());
  const service = new SwfService({
    serviceHome: home,
    endpoint: `http://127.0.0.1:${(endpointPort += 1)}`,
    projectTrust: async () => true,
    harnessAdapters: [new FakePlanningAdapter()],
    herdrClient: new HerdrClient(runner),
    commandRunner: runner,
    openRoadAdapter: options.wrapOpenRoad?.(inner) ?? inner,
    adoptSameProcessLock: false,
  });
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Roadmap e2e project",
    root: projectRoot,
  });
  return {
    service,
    projectRoot,
    roadmapPath,
    intake: async (type = "roadmap-new") =>
      (await service.command({ type, projectId })) as RoadmapIntakeResult,
  };
}

async function boundChanges(projectRoot: string): Promise<string[]> {
  const bindings = JSON.parse(
    await readFile(
      join(projectRoot, ".swf-state", "run-bindings.json"),
      "utf8",
    ).catch(() => '{"byChangeIdentity":{}}'),
  ) as { byChangeIdentity: Record<string, string> };
  return Object.keys(bindings.byChangeIdentity).sort();
}

describe.skipIf(!openRoadAvailable)(
  "roadmap intake against the real OpenRoad CLI",
  () => {
    it("starts the item OpenRoad's priority and dependency rules select", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-001",
            title: "Blocked by a dependency",
            status: "ready",
            priority: 1,
            dependsOn: ["RM-003"],
          },
          {
            id: "RM-002",
            title: "Eligible outcome",
            status: "ready",
            priority: 20,
          },
          {
            id: "RM-003",
            title: "Unfinished dependency",
            status: "planned",
            priority: 5,
          },
        ]),
      );
      const before = await readFile(harness.roadmapPath, "utf8");

      const result = await harness.intake();
      expect(result).toMatchObject({
        intake: "selected",
        itemId: "RM-002",
        changeName: "eligible-outcome",
        status: "paused",
      });

      // SWF took the item OpenRoad returned rather than the lowest number.
      const after = await readFile(harness.roadmapPath, "utf8");
      expect(after).not.toBe(before);
      expect(after).toContain("**Change:** eligible-outcome");
      expect(after.match(/\*\*Change:\*\*/g)).toHaveLength(1);
      // RM-001's unmet dependency left it exactly as written.
      expect(after).toContain("### RM-001 — Blocked by a dependency");
      expect(after).toMatch(/### RM-001[\s\S]*?\*\*Status:\*\* ready/);
      await harness.service.shutdown();
    });

    it("starts eligible work while other items are active, blocked, or paused", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-010",
            title: "Already running",
            status: "active",
            workState: "available",
            priority: 1,
            change: "already-running",
          },
          {
            id: "RM-011",
            title: "Paused elsewhere",
            status: "active",
            workState: "paused",
            priority: 2,
            change: "paused-elsewhere",
          },
          {
            id: "RM-012",
            title: "Next eligible outcome",
            status: "ready",
            priority: 30,
          },
        ]),
      );
      const result = await harness.intake();
      expect(result).toMatchObject({
        intake: "selected",
        itemId: "RM-012",
      });
      expect(result.conflicts).toBeUndefined();
      const after = await readFile(harness.roadmapPath, "utf8");
      expect(after).toContain("**Change:** already-running");
      expect(after).toContain("**Change:** paused-elsewhere");
      expect(after).toContain("**Change:** next-eligible-outcome");
      await harness.service.shutdown();
    });

    it("creates nothing and leaves the roadmap alone when nothing is eligible", async () => {
      const harness = await setup(
        roadmap([
          { id: "RM-020", title: "Not ready", status: "planned", priority: 1 },
          { id: "RM-021", title: "Finished", status: "done", priority: 2 },
        ]),
      );
      const before = await readFile(harness.roadmapPath, "utf8");

      const result = await harness.intake();
      expect(result).toMatchObject({ intake: "no-eligible-work" });
      expect(result.runId).toBeUndefined();
      expect(result.diagnostics[0]?.code).toBe("no_ready_items");
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(before);
      expect(await boundChanges(harness.projectRoot)).toEqual([]);
      await harness.service.shutdown();
    });

    it("creates nothing and leaves the roadmap alone when it is invalid", async () => {
      const harness = await setup(
        [
          "# OpenRoad",
          "",
          "## Items",
          "",
          "### RM-030 — Duplicated",
          "",
          "**Status:** ready",
          "**Priority:** 1",
          "**Depends on:**",
          "",
          "### RM-030 — Duplicated again",
          "",
          "**Status:** ready",
          "**Priority:** 2",
          "**Depends on:**",
          "",
        ].join("\n"),
      );
      const before = await readFile(harness.roadmapPath, "utf8");

      const result = await harness.intake();
      expect(result).toMatchObject({ intake: "invalid-roadmap" });
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.runId).toBeUndefined();
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(before);
      expect(await boundChanges(harness.projectRoot)).toEqual([]);
      await harness.service.shutdown();
    });

    it("converges on one item, change, and run when intake is repeated", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-040",
            title: "Repeatable outcome",
            status: "ready",
            priority: 1,
          },
        ]),
      );
      const first = await harness.intake();
      const linked = await readFile(harness.roadmapPath, "utf8");

      const second = await harness.intake();
      expect(second).toMatchObject({
        intake: "resumed",
        itemId: "RM-040",
        changeName: first.changeName,
        runId: first.runId,
      });
      // The second request neither re-linked nor re-wrote the roadmap.
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(linked);
      expect(await boundChanges(harness.projectRoot)).toEqual([
        "openspec/changes/repeatable-outcome",
      ]);
      await harness.service.shutdown();
    });

    it("recovers a run that exists without roadmap activation", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-050",
            title: "Interrupted linking",
            status: "ready",
            priority: 1,
          },
        ]),
        { wrapOpenRoad: (inner) => new InterruptingOpenRoad(inner) },
      );
      await expect(harness.intake()).rejects.toThrow();

      const stateDirectory = join(harness.projectRoot, ".swf-state");
      const journal = new RoadmapIntakeJournal(stateDirectory);
      expect(await journal.incomplete()).toHaveLength(1);
      // The run exists, but OpenRoad has not activated the item yet.
      expect(await readFile(harness.roadmapPath, "utf8")).not.toContain(
        "**Change:**",
      );
      expect(await boundChanges(harness.projectRoot)).toEqual([
        "openspec/changes/interrupted-linking",
      ]);

      const recovered = await harness.intake();
      expect(recovered).toMatchObject({
        intake: "recovered",
        itemId: "RM-050",
        changeName: "interrupted-linking",
      });
      expect(await readFile(harness.roadmapPath, "utf8")).toContain(
        "**Change:** interrupted-linking",
      );
      expect(await journal.incomplete()).toHaveLength(0);
      expect(await boundChanges(harness.projectRoot)).toEqual([
        "openspec/changes/interrupted-linking",
      ]);
      await harness.service.shutdown();
    });

    it("recovers a roadmap link that exists without a run", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-060",
            title: "Link without run",
            status: "ready",
            priority: 1,
          },
        ]),
      );
      // OpenRoad activated the item through its own operation; SWF was
      // interrupted before the run existed and only its intent survives.
      await mkdir(
        join(harness.projectRoot, "openspec", "changes", "link-without-run"),
        { recursive: true },
      );
      await execute("openroad", [
        "start",
        "RM-060",
        "--change",
        "link-without-run",
        "--root",
        harness.projectRoot,
      ]);
      await new RoadmapIntakeJournal(
        join(harness.projectRoot, ".swf-state"),
      ).record({
        operationId: crypto.randomUUID(),
        itemId: "RM-060",
        itemTitle: "Link without run",
        changeName: "link-without-run",
        mode: "planning-only",
        step: "intent-recorded",
      });
      const linked = await readFile(harness.roadmapPath, "utf8");

      const recovered = await harness.intake();
      expect(recovered).toMatchObject({
        intake: "recovered",
        itemId: "RM-060",
        changeName: "link-without-run",
        status: "paused",
      });
      expect(await boundChanges(harness.projectRoot)).toEqual([
        "openspec/changes/link-without-run",
      ]);
      expect(
        (
          await new RunEventStore(
            join(harness.projectRoot, ".swf-state"),
          ).readRun(recovered.runId!)
        ).roadmap?.itemId,
      ).toBe("RM-060");
      // Recovery relinked idempotently rather than rewriting the roadmap.
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(linked);
      await harness.service.shutdown();
    });

    it("reports OpenRoad's conflict without mutating the roadmap", async () => {
      const harness = await setup(
        roadmap([
          { id: "RM-070", title: "Contested", status: "ready", priority: 1 },
          {
            id: "RM-071",
            title: "Owner",
            status: "active",
            workState: "available",
            priority: 2,
            change: "contested",
          },
        ]),
      );
      await new RoadmapIntakeJournal(
        join(harness.projectRoot, ".swf-state"),
      ).record({
        operationId: crypto.randomUUID(),
        itemId: "RM-070",
        itemTitle: "Contested",
        changeName: "contested",
        mode: "planning-only",
        step: "intent-recorded",
      });
      const before = await readFile(harness.roadmapPath, "utf8");

      const result = await harness.intake();
      expect(result.intake).toBe("conflict");
      expect(result.diagnostics.map(({ code }) => code)).toContain(
        "change_already_linked",
      );
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(before);
      await harness.service.shutdown();
    });

    it("does not adopt a roadmap link made outside SWF", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-085",
            title: "Linked by hand",
            status: "ready",
            priority: 1,
          },
        ]),
      );
      // An operator linked the item with OpenRoad directly, so SWF holds no
      // recorded intent for it.
      await mkdir(
        join(harness.projectRoot, "openspec", "changes", "linked-by-hand"),
        { recursive: true },
      );
      await execute("openroad", [
        "start",
        "RM-085",
        "--change",
        "linked-by-hand",
        "--root",
        harness.projectRoot,
      ]);
      const linked = await readFile(harness.roadmapPath, "utf8");

      const result = await harness.intake();
      expect(result).toMatchObject({ intake: "no-eligible-work" });
      expect(result.runId).toBeUndefined();
      expect(await boundChanges(harness.projectRoot)).toEqual([]);
      // Neither adopted nor disturbed; direct entry remains the way in.
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(linked);
      await harness.service.shutdown();
    });

    it("never writes the roadmap file outside an OpenRoad operation", async () => {
      const harness = await setup(
        roadmap([
          {
            id: "RM-080",
            title: "Only openroad writes",
            status: "ready",
            priority: 1,
          },
        ]),
      );
      const before = await readFile(harness.roadmapPath, "utf8");

      // Reads that create nothing must leave the file byte-identical.
      const reconciled = await harness.intake("roadmap-reconcile");
      expect(reconciled.intake).toBe("recovered");
      expect(await readFile(harness.roadmapPath, "utf8")).toBe(before);

      await harness.intake();
      const linked = await readFile(harness.roadmapPath, "utf8");
      // The only difference is the activation OpenRoad itself performed.
      expect(linked).toContain("**Status:** active");
      expect(linked).toContain("**Change:** only-openroad-writes");
      expect(
        before.replace(/\*\*Status:\*\* ready/, "**Status:** active"),
      ).not.toBe(linked);
      expect(
        (await readFile(harness.roadmapPath, "utf8")).startsWith("# OpenRoad"),
      ).toBe(true);
      await harness.service.shutdown();
    });
  },
);
