import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitClient,
  HerdrClient,
  HerdrCommandError,
  NodeCommandRunner,
  RunRuntime,
  RuntimeOwnershipStore,
  type CommandOptions,
  type ProcessResult,
  type CommandRunner,
} from "../src/index.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "swf-runtime-"));
  directories.push(directory);
  return directory;
}

async function gitSetup(): Promise<string> {
  const root = await temporaryDirectory();
  const runner = new NodeCommandRunner();
  async function git(args: string[]): Promise<void> {
    const result = await runner.run("git", args, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr);
  }
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "swf@example.test"]);
  await git(["config", "user.name", "SWF test"]);
  await writeFile(join(root, "README.md"), "initial\n");
  await writeFile(join(root, ".gitignore"), ".swf-state/\n");
  await git(["add", "README.md", ".gitignore"]);
  await git(["commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FakeHerdrRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  status: "idle" | "working" | "blocked" | "done" | "unknown" = "idle";
  missingPane = false;

  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args });
    if (command === "which")
      return {
        code: args[0] === "pi" ? 0 : 1,
        stdout: args[0] === "pi" ? "/test/pi\n" : "",
        stderr: "",
      };
    if (args[0] === "integration")
      return {
        code: 0,
        stdout:
          "pi: current (v5) (/tmp/herdr-agent-state.ts)\ncodex: not installed\n",
        stderr: "",
      };
    if (args[0] === "workspace" && args[1] === "create")
      return {
        code: 0,
        stdout: '{"workspace":{"workspace_id":"w1"}}',
        stderr: "",
      };
    if (args[0] === "worktree" && args[1] === "open")
      return {
        code: 0,
        stdout: '{"worktree":{"worktree_id":"wt1"}}',
        stderr: "",
      };
    if (args[0] === "tab" && args[1] === "create") {
      return {
        code: 0,
        stdout:
          '{"tab":{"tab_id":"t1"},"pane":{"pane_id":"p1","terminal_id":"term1","process_id":"proc1"}}',
        stderr: "",
      };
    }
    if (args[0] === "pane" && args[1] === "get") {
      if (this.missingPane)
        return { code: 1, stdout: "", stderr: "pane missing" };
      return {
        code: 0,
        stdout: JSON.stringify({
          pane: { pane_id: "p1", agent_status: this.status },
        }),
        stderr: "",
      };
    }
    if (args[0] === "wait" && this.status !== "idle")
      return { code: 124, stdout: "", stderr: "timed out" };
    if (args[0] === "pane" && args[1] === "read")
      return { code: 0, stdout: "retained transcript\n", stderr: "" };
    if (
      (args[0] === "pane" &&
        ["run", "send-keys", "close"].includes(args[1]!)) ||
      (args[0] === "tab" && args[1] === "close") ||
      (args[0] === "workspace" && args[1] === "close") ||
      (args[0] === "worktree" && args[1] === "remove")
    )
      return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  }
}

describe("Git client", () => {
  it("operates on repository, branch, worktree, diff, commit, reset, and clean state through its runner", async () => {
    const root = await gitSetup();
    const git = new GitClient(root);
    expect(await git.repositoryRoot()).toBe(await realpath(root));
    expect(await git.branch()).toBe("main");
    expect(await git.isClean()).toBe(true);

    const worktreePath = join(root, ".swf-state", "worktrees", "run-1");
    await git.createWorktree({ path: worktreePath, branch: "swf/run-1" });
    const isolated = new GitClient(worktreePath);
    await writeFile(join(worktreePath, "README.md"), "changed\n");
    expect(await isolated.isClean()).toBe(false);
    expect(await isolated.diff()).toContain("-initial");
    const checkpoint = await isolated.commit("change readme");
    expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(worktreePath, "scratch.txt"), "remove me\n");
    await isolated.reset(checkpoint!, { clean: true });
    expect(await isolated.isClean()).toBe(true);
    expect(await isolated.commit("no changes")).toBeUndefined();
    expect(await git.isClean()).toBe(true);
    await git.removeWorktree(worktreePath);
  });
});

describe("Herdr runtime", () => {
  it("launches, waits, prompts, observes, reads, cancels, and diagnoses through testable commands", async () => {
    const runner = new FakeHerdrRunner();
    const herdr = new HerdrClient(runner);
    const workspace = await herdr.createWorkspace({
      cwd: "/repo",
      label: "swf-run",
    });
    const observation = await herdr.launch({
      workspaceId: workspace.workspaceId!,
      cwd: "/repo/worktree",
      label: "builder",
      command: "pi",
      timeoutMs: 10,
    });
    expect(observation).toMatchObject({
      paneId: "p1",
      status: "idle",
      terminalId: "term1",
      processId: "proc1",
    });
    await herdr.submitPrompt("p1", "Implement the task");
    expect(await herdr.transcript("p1")).toContain("retained transcript");
    await herdr.cancel("p1");
    expect(await herdr.diagnostics(["pi"], ["pi"])).toMatchObject({
      ready: true,
    });
    expect(
      runner.calls.some(
        (call) => call.args.join(" ") === "pane send-keys p1 ctrl-c",
      ),
    ).toBe(true);
  });

  it("reports blocked, timeout, and missing panes explicitly", async () => {
    const runner = new FakeHerdrRunner();
    const herdr = new HerdrClient(runner);
    runner.status = "blocked";
    await expect(herdr.waitForReady("p1", 1)).rejects.toBeInstanceOf(
      HerdrCommandError,
    );
    expect((await herdr.observe("p1")).status).toBe("blocked");
    runner.missingPane = true;
    await expect(herdr.reconcilePane("p1")).resolves.toBe("missing");
  });

  it("records only owned resources and cleans only those resources", async () => {
    const root = await gitSetup();
    const runner = new FakeHerdrRunner();
    const ownership = new RuntimeOwnershipStore(join(root, ".swf-state"));
    const runtime = new RunRuntime(
      new GitClient(root),
      new HerdrClient(runner),
      ownership,
    );
    const prepared = await runtime.prepare({
      runId: "run-1",
      stateDirectory: join(root, ".swf-state"),
    });
    expect(await new GitClient(prepared.worktree.path).branch()).toBe(
      "swf/run-1",
    );
    await runtime.launch("run-1", {
      cwd: prepared.worktree.path,
      label: "builder",
      command: "pi",
      timeoutMs: 10,
    });
    const recorded = await ownership.load("run-1");
    expect(recorded?.resources.map((resource) => resource.resourceId)).toEqual(
      expect.arrayContaining(["w1", "wt1", "t1", "p1", "term1", "proc1"]),
    );
    const restarted = new RunRuntime(
      new GitClient(root),
      new HerdrClient(runner),
      ownership,
    );
    expect(await restarted.reconcile("run-1")).toMatchObject({
      status: "completed",
      paneId: "p1",
    });
    runner.status = "working";
    expect(await restarted.reconcile("run-1")).toMatchObject({
      status: "active",
      paneId: "p1",
    });
    runner.status = "blocked";
    expect(await restarted.reconcile("run-1")).toMatchObject({
      status: "blocked",
      paneId: "p1",
    });
    runner.status = "unknown";
    expect(await restarted.reconcile("run-1")).toMatchObject({
      status: "unknown",
      paneId: "p1",
    });
    runner.missingPane = true;
    expect(await restarted.reconcile("run-1")).toMatchObject({
      status: "missing",
      paneId: "p1",
    });

    await restarted.cleanup("run-1");
    expect(
      runner.calls.some((call) => call.args.join(" ") === "pane close p1"),
    ).toBe(true);
    expect(
      runner.calls.some((call) => call.args.join(" ") === "workspace close w1"),
    ).toBe(true);
    expect(
      runner.calls.some((call) => call.args.includes("unowned-pane")),
    ).toBe(false);
    await expect(stat(prepared.worktree.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
