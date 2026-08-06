import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  assertReadOnlyExplorationCommand,
  explorationEnvironment,
  ExplorationStore,
  requestStructuredHandoff,
  normalizePlanningInput,
  type GitClient,
} from "../src/index.js";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "swf-evidence-"));
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

const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";

describe("artifact evidence", () => {
  it("persists typed manifests, deterministic command and Git evidence, and reuses only exact inputs", async () => {
    const root = await temporaryDirectory();
    const store = new ArtifactStore(root, runId);
    const command = await store.captureCommand({
      phaseId: "planning",
      command: "pnpm test",
      configuration: { node: 22 },
      commit: "abc",
      exitCode: 0,
      stdout: "tests passed",
      stderr: "",
    });
    expect(command.result).toMatchObject({
      command: "pnpm test",
      commit: "abc",
      exitCode: 0,
      summary: "tests passed",
    });
    expect(
      await store.reusable("pnpm test", { node: 22 }, "abc"),
    ).toMatchObject({ artifactId: command.artifact.artifactId });
    expect(
      await store.reusable("pnpm test", { node: 23 }, "abc"),
    ).toBeUndefined();
    expect(
      await store.reusable("pnpm test", { node: 22 }, "def"),
    ).toBeUndefined();

    const git = {
      async status() {
        return {
          branch: "swf/run",
          head: "def",
          files: [{ path: "src/a.ts", index: "M", worktree: " " }],
          clean: false,
        };
      },
      async head() {
        return "def";
      },
      async diff() {
        return "diff --git a/src/a.ts b/src/a.ts";
      },
    } as unknown as GitClient;
    const evidence = await store.captureGitEvidence({
      phaseId: "planning",
      beforeCommit: "abc",
      git,
    });
    expect(evidence.evidence).toMatchObject({
      beforeCommit: "abc",
      afterCommit: "def",
      changedFiles: ["src/a.ts"],
      clean: false,
    });
    expect(
      await readFile(
        join(root, "runs", runId, evidence.evidence.diffRef),
        "utf8",
      ),
    ).toContain("diff --git");

    const validation = await store.captureOpenSpecEvidence({
      phaseId: "planning",
      commit: "def",
      command: "openspec validate change",
      exitCode: 1,
      output: "invalid task",
    });
    expect(validation.artifact.status).toBe("invalid");
    await store.consume(command.artifact.artifactId, "reviewing");
    const stale = await store.invalidateForSourceChange("def");
    expect(stale.map(({ artifactId }) => artifactId)).toContain(
      command.artifact.artifactId,
    );
    expect(
      (await store.load()).artifacts.find(
        ({ artifactId }) => artifactId === command.artifact.artifactId,
      ),
    ).toMatchObject({ status: "stale", consumers: ["reviewing"] });
    await store.invalidateForRunMutation({
      kind: "rollback",
      artifactIds: [evidence.artifact.artifactId],
    });
    expect(
      (await store.load()).artifacts.find(
        ({ artifactId }) => artifactId === evidence.artifact.artifactId,
      )?.status,
    ).toBe("invalid");
  });

  it("constructs selective bounded context and falls back when a same-agent handoff is invalid", async () => {
    const root = await temporaryDirectory();
    const store = new ArtifactStore(root, runId);
    const { artifact } = await store.captureCommand({
      phaseId: "building",
      command: "pnpm test",
      configuration: {},
      commit: "abc",
      exitCode: 0,
      stdout: "x".repeat(3_000),
      stderr: "",
    });
    const context = await store.selectContext({
      openspec: ["proposal.md"],
      phaseIds: ["building"],
    });
    expect(context).toMatchObject({
      openspec: ["proposal.md"],
      rawOutputRefs: [],
      evidence: [{ artifactId: artifact.artifactId }],
    });
    const handoff = await requestStructuredHandoff({
      runId,
      phaseId: "building",
      facts: context,
      agent: {
        async requestHandoff() {
          return { nope: true };
        },
      },
    });
    expect(handoff).toMatchObject({
      degraded: true,
      artifactIds: [artifact.artifactId],
    });
    expect(await store.retainHandoff(handoff)).toContain("handoffs/");
  });
});

describe("explorations", () => {
  it("persists read-only exploration history, validates its brief, and promotes only an explicit selection", async () => {
    const root = await temporaryDirectory();
    const store = new ExplorationStore(root);
    const first = await store.start("Investigate authentication");
    const second = await store.start("Investigate billing");
    const inspection = await store.executeReadOnly(
      first.explorationId,
      "Inspect auth",
      {
        async execute({ environment }) {
          expect(environment.SWF_EXPLORATION_READ_ONLY).toBe("1");
          return {
            transcript: "Read src/auth.ts\n",
            question: "Which provider?",
          };
        },
      },
    );
    expect(inspection.question).toBe("Which provider?");
    await store.answer(first.explorationId, "Use sessions");
    await store.recordBrief({
      explorationId: first.explorationId,
      problem: "No authentication",
      goals: ["Secure routes"],
      nonGoals: ["Billing"],
      options: ["sessions"],
      decisions: ["use sessions"],
      openQuestions: [],
      codebaseFindings: ["routes are public"],
      candidateScope: "auth routes",
      candidateChangeName: "add-user-auth",
    });
    expect(
      (await store.list()).map(({ explorationId }) => explorationId),
    ).toContain(second.explorationId);
    const promoted = await store.promote(first.explorationId);
    expect(promoted).toMatchObject({
      explorationId: first.explorationId,
      candidateChangeName: "add-user-auth",
    });
    expect(normalizePlanningInput({ exploration: promoted })).toMatchObject({
      kind: "exploration",
      brief: { explorationId: first.explorationId },
    });
    await store.discard(second.explorationId);
    await expect(store.resume(second.explorationId)).rejects.toThrow(
      "Discarded exploration",
    );
    expect(explorationEnvironment(first.explorationId)).toMatchObject({
      SWF_EXPLORATION_READ_ONLY: "1",
    });
    expect(() => assertReadOnlyExplorationCommand("git commit -m bad")).toThrow(
      "read-only",
    );
    expect(() =>
      assertReadOnlyExplorationCommand("git status --short"),
    ).not.toThrow();
    expect(await store.retainedBytes(first.explorationId)).toBeGreaterThan(0);
  });
});
