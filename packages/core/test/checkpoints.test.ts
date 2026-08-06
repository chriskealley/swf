import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  CheckpointManager,
  RunEventStore,
  persistChangeDossier,
  validateChangeDossier,
  validateDossierWithOpenSpec,
  type GitClient,
} from "../src/index.js";

const directories: string[] = [];
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "swf-checkpoint-"));
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

function fakeGit(
  input: { committed?: string; head?: string; changed?: string[] } = {},
) {
  const calls: string[] = [];
  let firstStatus = true;
  return {
    calls,
    async commit() {
      calls.push("commit");
      return input.committed;
    },
    async head() {
      calls.push("head");
      return input.head ?? "base";
    },
    async status() {
      calls.push("status");
      const files = firstStatus
        ? (input.changed ?? ["src/a.ts"]).map((path) => ({
            path,
            index: "M",
            worktree: " ",
          }))
        : [];
      firstStatus = false;
      return {
        branch: "swf/run",
        head: input.committed ?? input.head ?? "base",
        files,
        clean: files.length === 0,
      };
    },
    async reset(commit: string, options?: { clean?: boolean }) {
      calls.push(`reset:${commit}:${options?.clean}`);
    },
  } as unknown as GitClient & { calls: string[] };
}

async function runStore(root: string) {
  const events = new RunEventStore(root);
  await events.create({
    projectId,
    runId,
    changeName: "add-user-auth",
    changeIdentity: "changes/add-user-auth#1",
    workflowId: "default",
    description: "Add auth",
    phaseIds: ["building", "reviewing"],
    createdAt: "2026-04-02T12:00:00.000Z",
  });
  return events;
}

describe("phase checkpoints and rollback", () => {
  it("commits changed phase work, persists complete checkpoint evidence, and appends history", async () => {
    const root = await temporaryDirectory();
    const artifacts = new ArtifactStore(root, runId);
    const { artifact } = await artifacts.captureCommand({
      phaseId: "building",
      command: "pnpm test",
      configuration: {},
      commit: "base",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    });
    const events = await runStore(root);
    const git = fakeGit({ committed: "checkpoint", changed: ["src/a.ts"] });
    const manager = new CheckpointManager(root, runId, git, artifacts, events);
    const checkpoint = await manager.create({
      phaseId: "building",
      beforeCommit: "base",
      gateDecision: "satisfied",
      handoff: {
        schemaVersion: 1,
        handoffId: "c3f27ba2-5d2e-4e93-a347-962cb8adc483",
        runId,
        phaseId: "building",
        summary: ["Done"],
        decisions: [],
        knownIssues: [],
        recommendedNextActions: [],
        artifactIds: [artifact.artifactId],
        degraded: false,
      },
    });
    expect(checkpoint).toMatchObject({
      beforeCommit: "base",
      afterCommit: "checkpoint",
      logical: false,
      changedFiles: ["src/a.ts"],
      clean: true,
      artifactIds: [artifact.artifactId],
      gateDecision: "satisfied",
    });
    expect(git.calls).toContain("commit");
    expect(
      (await events.load(runId)).state.checkpoints[checkpoint.checkpointId],
    ).toBeDefined();
  });

  it("creates a logical checkpoint for no tracked changes and preserves history while rolling back", async () => {
    const root = await temporaryDirectory();
    const artifacts = new ArtifactStore(root, runId);
    const { artifact } = await artifacts.captureCommand({
      phaseId: "reviewing",
      command: "pnpm test",
      configuration: {},
      commit: "base",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    });
    const events = await runStore(root);
    const git = fakeGit({ head: "base", changed: [] });
    const manager = new CheckpointManager(root, runId, git, artifacts, events);
    const checkpoint = await manager.create({
      phaseId: "building",
      beforeCommit: "base",
      gateDecision: "satisfied",
    });
    expect(checkpoint).toMatchObject({
      afterCommit: "base",
      logical: true,
      changedFiles: [],
    });
    await expect(
      manager.rollback({
        checkpointId: checkpoint.checkpointId,
        phaseId: "building",
        invalidatedPhaseIds: ["reviewing"],
        invalidatedArtifactIds: [artifact.artifactId],
        authorized: false,
      }),
    ).rejects.toThrow("authorization");
    await manager.rollback({
      checkpointId: checkpoint.checkpointId,
      phaseId: "building",
      invalidatedPhaseIds: ["reviewing"],
      invalidatedArtifactIds: [artifact.artifactId],
      authorized: true,
    });
    expect(git.calls).toContain("reset:base:true");
    expect(
      (await artifacts.load()).artifacts.find(
        ({ artifactId }) => artifactId === artifact.artifactId,
      )?.status,
    ).toBe("invalid");
    const loaded = await events.load(runId);
    expect(loaded.events.map(({ type }) => type)).toContain("run.rolled-back");
    expect(loaded.state.phases.reviewing?.status).toBe("pending");
  });
});

describe("portable OpenSpec dossier", () => {
  it("writes compact evidence without raw payloads and remains available after an archived-change move", async () => {
    const root = await temporaryDirectory();
    const change = join(root, "openspec", "changes", "add-user-auth");
    const artifacts = new ArtifactStore(root, runId);
    await artifacts.captureCommand({
      phaseId: "building",
      command: "pnpm test",
      configuration: {},
      commit: "base",
      exitCode: 0,
      stdout: "large output",
      stderr: "",
    });
    const { path, dossier } = await persistChangeDossier({
      changeRoot: change,
      runId,
      artifacts,
      finalReport: "Change complete; token=super-secret",
    });
    expect(path).toBe(join(change, "evidence", "dossier.json"));
    expect(dossier).toMatchObject({
      rawHistory: "unavailable-in-portable-dossier",
      finalReport: "Change complete; token=[REDACTED]",
    });
    await expect(validateChangeDossier(change)).resolves.toMatchObject({
      runId,
    });
    const calls: string[] = [];
    await validateDossierWithOpenSpec({
      changeName: "add-user-auth",
      cwd: root,
      runner: {
        async run(command, args) {
          calls.push(`${command} ${args.join(" ")}`);
          return { code: 0, stdout: "valid", stderr: "" };
        },
      },
    });
    expect(calls).toEqual(["openspec validate add-user-auth"]);
    const archived = join(
      root,
      "openspec",
      "changes",
      "archive",
      "2026-04-02-add-user-auth",
    );
    await mkdir(join(root, "openspec", "changes", "archive"), {
      recursive: true,
    });
    await rename(change, archived);
    await expect(validateChangeDossier(archived)).resolves.toMatchObject({
      runId,
    });
  });
});
