import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitClient,
  applyCheckAdoption,
  applyModelMapping,
  releasePreflight,
  summarizeReleaseApproval,
  type CommandRunner,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

class FakeRunner implements CommandRunner {
  readonly calls: string[] = [];
  constructor(
    readonly dirty = false,
    readonly targetCommit = "target",
    readonly conflict = false,
  ) {}
  async run(command: string, args: string[]) {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "status")
      return { code: 0, stdout: this.dirty ? " M file.ts\0" : "", stderr: "" };
    if (command === "git" && args[0] === "branch")
      return { code: 0, stdout: "swf/run\n", stderr: "" };
    if (command === "git" && args[0] === "rev-parse")
      return {
        code: 0,
        stdout: `${args[1] === "main" ? this.targetCommit : "source"}\n`,
        stderr: "",
      };
    if (command === "git" && args[0] === "merge-tree")
      return this.conflict
        ? { code: 1, stdout: "CONFLICT in app.ts\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "remote")
      return { code: 0, stdout: "git@example/repo\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("deterministic release and reviewed adoption", () => {
  it("fails release preflight for a dirty source and summarizes approval inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-release-"));
    roots.push(root);
    const runner = new FakeRunner(true);
    const preflight = await releasePreflight({
      runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
      git: new GitClient(root, runner),
      runner,
      sourceBranch: "swf/run",
      targetBranch: "main",
      remote: "origin",
      mergeMethod: "merge",
      expectedSourceCommit: "source",
      requireCleanSource: true,
    });
    expect(preflight.valid).toBe(false);
    expect(
      summarizeReleaseApproval({
        preflight,
        evidence: ["audit"],
        risks: ["dirty source"],
        cleanupPlan: ["retain worktree"],
      }),
    ).toContain("preflight blocked");
  });

  it("blocks target drift and merge conflicts without mutating either branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-release-safety-"));
    roots.push(root);
    const driftRunner = new FakeRunner(false, "target-advanced");
    const drift = await releasePreflight({
      runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
      git: new GitClient(root, driftRunner),
      runner: driftRunner,
      sourceBranch: "swf/run",
      targetBranch: "main",
      remote: "origin",
      mergeMethod: "merge",
      expectedSourceCommit: "source",
      expectedTargetCommit: "target",
      requireCleanSource: true,
    });
    expect(drift.valid).toBe(false);
    expect(drift.checks).toContainEqual(
      expect.objectContaining({ id: "target-drift", status: "failed" }),
    );

    const conflictRunner = new FakeRunner(false, "target", true);
    const conflict = await releasePreflight({
      runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
      git: new GitClient(root, conflictRunner),
      runner: conflictRunner,
      sourceBranch: "swf/run",
      targetBranch: "main",
      remote: "origin",
      mergeMethod: "merge",
      expectedSourceCommit: "source",
      requireCleanSource: true,
    });
    expect(conflict.valid).toBe(false);
    expect(conflict.checks).toContainEqual(
      expect.objectContaining({ id: "merge-conflict", status: "failed" }),
    );
    expect(
      [...driftRunner.calls, ...conflictRunner.calls].some((call) =>
        /git (merge(?:\s|$)|rebase(?:\s|$)|branch -D|worktree remove)/.test(
          call,
        ),
      ),
    ).toBe(false);
  });

  it("applies only confirmed model mappings and discovered checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-adopt-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "pnpm test" } }),
    );
    await writeFile(
      join(root, ".swf-workflow.yaml"),
      "schemaVersion: 1\nid: default\ndescription: test\nphases:\n  - id: verifying\n    title: Verifying\n    profile: verifier\n    checks: []\ndelivery: { mode: pull-request, mergeMethod: merge }\n",
    );
    await applyModelMapping({
      root,
      tier: "fast",
      harness: "pi",
      model: "provider/fast",
      confirmed: true,
    });
    expect(await readFile(join(root, ".swf/models.yaml"), "utf8")).toContain(
      "provider/fast",
    );
    const candidate = {
      id: "test-package",
      command: "pnpm run test",
      source: "package.json",
      proposedPhase: "verifying" as const,
      cwd: root,
      timeoutMs: 1_000,
      required: true,
      rationale: "test",
    };
    await applyCheckAdoption({
      root,
      configPath: ".swf-workflow.yaml",
      candidates: [candidate],
      selectedIds: [candidate.id],
      confirmed: true,
    });
    expect(await readFile(join(root, ".swf-workflow.yaml"), "utf8")).toContain(
      "test-package",
    );
  });
});
