import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  AuditLog,
  Redactor,
  RunEventStore,
  StateMigrationManager,
  assertBudgetsAvailable,
  assertLoopbackHttpEndpoint,
  assertSafeGitBranchName,
  assertSafeGitRemoteName,
  evaluateBudgets,
  exportRun,
  importRun,
  inspectOperationalHealth,
} from "../src/index.js";

const directories: string[] = [];
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";
const secondRunId = "9c86919c-3569-4e97-9f09-1bba7b49ed3d";

async function temporaryDirectory(prefix = "swf-hardening-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function createRun(
  stateDirectory: string,
  id = runId,
  changeName = "secure-change",
) {
  const store = new RunEventStore(stateDirectory);
  await store.create({
    projectId,
    runId: id,
    changeName,
    changeIdentity: `changes/${changeName}`,
    workflowId: "default",
    description: "Secure the operation",
    phaseIds: ["planning"],
  });
  return store;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("security and retention", () => {
  it("redacts configured and recognized secrets without corrupting usage fields", async () => {
    const redactor = new Redactor({ sensitiveValues: ["private-value"] });
    expect(
      redactor.value({
        authorization: "Bearer abcdefghijklmnop",
        message: "token=private-value sk-proj-abcdefghijklmnop",
        inputTokens: 12,
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      message: "[REDACTED] [REDACTED]",
      inputTokens: 12,
    });

    const home = await temporaryDirectory();
    const path = join(home, "audit.jsonl");
    await new AuditLog(path, redactor).append({
      operation: "test",
      actor: { type: "user", id: "operator" },
      outcome: "completed",
      details: { value: "private-value" },
    });
    expect(await readFile(path, "utf8")).not.toContain("private-value");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(() => assertLoopbackHttpEndpoint("http://0.0.0.0:3000")).toThrow(
      "loopback",
    );
    expect(assertSafeGitRemoteName("origin")).toBe("origin");
    expect(assertSafeGitBranchName("release/0.1.0-prep")).toBe(
      "release/0.1.0-prep",
    );
    expect(() => assertSafeGitRemoteName("--upload-pack=malware")).toThrow(
      "remote",
    );
    expect(() => assertSafeGitBranchName("--help")).toThrow("branch");
  });

  it("redacts events and artifacts before persistence and marks pruned references", async () => {
    const state = await temporaryDirectory();
    const redactor = new Redactor({ sensitiveValues: ["top-secret"] });
    const store = new RunEventStore(state, { redaction: redactor });
    await store.create({
      projectId,
      runId,
      changeName: "secure-change",
      changeIdentity: "changes/secure-change",
      workflowId: "default",
      description: "Never retain top-secret",
      phaseIds: ["planning"],
    });
    await store.append(runId, {
      type: "run.transitioned",
      actor: { type: "service", id: "test" },
      context: {},
      data: { from: "pending", to: "running", reason: "top-secret" },
    });
    expect(
      await readFile(join(state, "runs", runId, "events.jsonl"), "utf8"),
    ).not.toContain("top-secret");

    const artifacts = new ArtifactStore(state, runId, redactor);
    const captured = await artifacts.captureCommand({
      phaseId: "planning",
      command: "echo top-secret",
      configuration: {},
      commit: "abc123",
      exitCode: 0,
      stdout: "top-secret",
      stderr: "",
    });
    expect(
      await readFile(
        join(state, "runs", runId, captured.result.rawOutputRef),
        "utf8",
      ),
    ).toBe("[REDACTED]");
    await rm(join(state, "runs", runId, captured.result.rawOutputRef));
    await artifacts.markRawOutputPruned(captured.result.rawOutputRef);
    expect((await artifacts.load()).artifacts[0]).toMatchObject({
      rawOutputAvailable: false,
      rawOutputUnavailableReason: "retention-policy",
    });
  });
});

describe("budgets", () => {
  it("enforces invocation, phase, run, project, and service scopes and fails closed", () => {
    const usage = [
      {
        invocationId: "invocation-1",
        projectId,
        runId,
        phaseId: "planning",
        costUsd: 2,
        costQuality: "exact" as const,
        tokens: 100,
      },
    ];
    const decisions = evaluateBudgets(
      {
        invocation: { maxTokens: 100 },
        phase: { maxCostUsd: 3 },
        run: { maxCostUsd: 2 },
        project: { maxTokens: 1_000 },
        service: { maxCostUsd: 10 },
      },
      usage,
      { projectId, runId, phaseId: "planning", invocationId: "invocation-1" },
    );
    expect(decisions).toHaveLength(5);
    expect(
      decisions.filter((entry) => !entry.allowed).map((entry) => entry.scope),
    ).toEqual(["run", "invocation"]);
    expect(() => assertBudgetsAvailable(decisions)).toThrow("Budget prevents");

    expect(
      evaluateBudgets(
        { service: { maxCostUsd: 10 } },
        [
          {
            ...usage[0]!,
            costUsd: undefined,
            costQuality: "unknown",
          },
        ],
        { projectId, runId },
      )[0],
    ).toMatchObject({ status: "indeterminate", allowed: false });
  });
});

describe("migration, transfer, and reconciliation", () => {
  it("previews, backs up, applies, and rolls back versioned migrations", async () => {
    const state = await temporaryDirectory();
    await writeFile(
      join(state, "state-version.json"),
      JSON.stringify({ schemaVersion: 1, stateVersion: 0 }),
    );
    await writeFile(join(state, "legacy.txt"), "before");
    const manager = new StateMigrationManager(state, [
      {
        from: 0,
        to: 1,
        description: "upgrade fixture",
        apply: async (root) => writeFile(join(root, "legacy.txt"), "after"),
      },
    ]);
    expect(await manager.migrate({ dryRun: true })).toMatchObject({
      applied: false,
      plan: { from: 0, to: 1 },
    });
    const result = await manager.migrate();
    expect(await readFile(join(state, "legacy.txt"), "utf8")).toBe("after");
    await manager.rollback(result.backupId!);
    expect(await readFile(join(state, "legacy.txt"), "utf8")).toBe("before");
  });

  it("exports and imports complete run history with manifest verification", async () => {
    const source = await temporaryDirectory();
    const target = await temporaryDirectory();
    await createRun(source);
    await mkdir(join(source, "runs", runId, "raw"), { recursive: true });
    await writeFile(join(source, "runs", runId, "raw", "agent.log"), "output");
    const archive = await exportRun(source, runId);
    await expect(importRun(target, archive)).resolves.toEqual({
      runId,
      files: archive.files.length,
    });
    expect((await new RunEventStore(target).load(runId)).state.run.runId).toBe(
      runId,
    );
    archive.manifestSha256 = "corrupted";
    await expect(
      importRun(await temporaryDirectory(), archive),
    ).rejects.toThrow("corrupted");
  });

  it("reports stuck invocations and only recorded orphan resources", async () => {
    const state = await temporaryDirectory();
    const store = await createRun(state);
    const startedAt = new Date(Date.now() - 7_200_000).toISOString();
    await store.append(runId, {
      type: "invocation.recorded",
      actor: { type: "harness", id: "simulated" },
      context: { phaseId: "planning" },
      data: {
        invocation: {
          schemaVersion: 1,
          invocationId: "550e8400-e29b-41d4-a716-446655440000",
          runId,
          phaseId: "planning",
          harness: "pi",
          status: "running",
          startedAt,
          cost: { quality: "unknown" },
        },
      },
    });
    const terminalStore = await createRun(
      state,
      secondRunId,
      "finished-change",
    );
    await terminalStore.append(secondRunId, {
      type: "run.transitioned",
      actor: { type: "service", id: "test" },
      context: {},
      data: { from: "pending", to: "running" },
    });
    await terminalStore.append(secondRunId, {
      type: "run.transitioned",
      actor: { type: "service", id: "test" },
      context: {},
      data: { from: "running", to: "completed" },
    });
    await writeFile(
      join(state, "runs", secondRunId, "runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: secondRunId,
        projectRoot: "/repo",
        branch: `swf/${secondRunId}`,
        worktreePath: "/repo/worktree",
        createdAt: startedAt,
        updatedAt: startedAt,
        resources: [
          {
            resourceId: "owned-pane",
            kind: "pane",
            createdAt: startedAt,
          },
        ],
      }),
    );
    const report = await inspectOperationalHealth(state, 1_000);
    expect(report.stuck).toHaveLength(1);
    expect(report.orphans[0]?.resources).toEqual([
      expect.objectContaining({ resourceId: "owned-pane" }),
    ]);
  });

  it("supports write fault injection for full disks and permission failures", async () => {
    const state = await temporaryDirectory();
    const fullDisk = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const store = new RunEventStore(state, {
      beforeWrite: (point) => {
        if (point === "event") throw fullDisk;
      },
    });
    await store.create({
      projectId,
      runId,
      changeName: "fault-injection",
      changeIdentity: "changes/fault-injection",
      workflowId: "default",
      description: "Fault",
      phaseIds: ["planning"],
    });
    await expect(
      store.append(runId, {
        type: "run.transitioned",
        actor: { type: "service", id: "test" },
        context: {},
        data: { from: "pending", to: "running" },
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await store.readEvents(runId)).toHaveLength(1);

    await chmod(join(state, "runs", runId, "events.jsonl"), 0o600);
    const denied = new RunEventStore(state, {
      beforeWrite: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    await expect(denied.rebuildSnapshot(runId)).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});
