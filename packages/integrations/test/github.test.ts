import { describe, expect, it } from "vitest";
import type { CommandOptions, CommandRunner, ProcessResult } from "@swf/core";
import { GitHubAdapter, githubRepositoryFromRemote } from "../src/index.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(
    readonly respond: (
      command: string,
      args: string[],
    ) => Partial<ProcessResult> | undefined,
  ) {}
  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "", ...this.respond(command, args) };
  }
}

const repositoryView = JSON.stringify({
  nameWithOwner: "acme/repo",
  viewerPermission: "WRITE",
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  autoMergeAllowed: true,
});

function successful(
  command: string,
  args: string[],
): Partial<ProcessResult> | undefined {
  const joined = `${command} ${args.join(" ")}`;
  if (joined.startsWith("git remote get-url"))
    return { stdout: "git@github.com:acme/repo.git\n" };
  if (joined.startsWith("gh repo view")) return { stdout: repositoryView };
  return undefined;
}

const preflight = {
  cwd: "/repo",
  mode: "pull-request" as const,
  remote: "origin",
  targetBranch: "main",
  sourceBranch: "swf/run",
  requireMergePermission: false,
  requireAutoMerge: false,
};

describe("GitHub hosting adapter", () => {
  it("recognizes only GitHub HTTPS and SSH remotes", () => {
    expect(githubRepositoryFromRemote("git@github.com:acme/repo.git")).toBe(
      "acme/repo",
    );
    expect(githubRepositoryFromRemote("https://github.com/acme/repo.git")).toBe(
      "acme/repo",
    );
    expect(
      githubRepositoryFromRemote("https://gitlab.com/acme/repo.git"),
    ).toBeUndefined();
  });

  it("fails preflight for missing and non-GitHub remotes", async () => {
    const missing = new GitHubAdapter(
      new FakeRunner((command, args) =>
        command === "git" && args[0] === "remote"
          ? { code: 2, stderr: "missing" }
          : undefined,
      ),
    );
    await expect(missing.preflight(preflight)).resolves.toMatchObject({
      valid: false,
      checks: [{ id: "remote", status: "failed" }],
    });

    const other = new GitHubAdapter(
      new FakeRunner((command, args) =>
        command === "git" && args[0] === "remote"
          ? { stdout: "https://gitlab.com/acme/repo.git" }
          : undefined,
      ),
    );
    await expect(other.preflight(preflight)).resolves.toMatchObject({
      valid: false,
      checks: [
        { id: "remote", status: "passed" },
        { id: "repository", status: "failed" },
      ],
    });
  });

  it("reports authentication, permission, target, and auto-merge failures", async () => {
    const adapter = new GitHubAdapter(
      new FakeRunner((command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined.startsWith("git remote"))
          return { stdout: "https://github.com/acme/repo.git" };
        if (joined.startsWith("git ls-remote"))
          return { code: 2, stderr: "missing branch" };
        if (joined.startsWith("git push --dry-run"))
          return { code: 1, stderr: "denied" };
        if (joined.startsWith("gh auth"))
          return { code: 1, stderr: "login required" };
        if (joined.startsWith("gh repo view"))
          return {
            stdout: JSON.stringify({
              nameWithOwner: "acme/repo",
              viewerPermission: "READ",
              autoMergeAllowed: false,
            }),
          };
        return undefined;
      }),
    );
    const result = await adapter.preflight({
      ...preflight,
      requireMergePermission: true,
      requireAutoMerge: true,
    });
    expect(result.valid).toBe(false);
    expect(
      result.checks
        .filter(({ status }) => status === "failed")
        .map(({ id }) => id),
    ).toEqual([
      "target-branch",
      "authentication",
      "pull-request",
      "push",
      "merge",
      "auto-merge",
    ]);
  });

  it("bypasses all GitHub checks for explicitly selected local-branch delivery", async () => {
    const runner = new FakeRunner(() => ({ code: 1 }));
    const result = await new GitHubAdapter(runner).preflight({
      ...preflight,
      mode: "local-branch",
    });
    expect(result).toMatchObject({ valid: true, skipped: true });
    expect(runner.calls).toHaveLength(0);
  });

  it("updates an existing pull request instead of creating a duplicate", async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "list")
        return {
          stdout: '[{"number":4,"url":"https://github.com/acme/repo/pull/4"}]',
        };
      return successful(command, args);
    });
    const result = await new GitHubAdapter(runner).createOrUpdatePullRequest({
      cwd: "/repo",
      repository: "acme/repo",
      remote: "origin",
      sourceBranch: "swf/run",
      targetBranch: "main",
      title: "Title",
      body: "Body",
    });
    expect(result).toMatchObject({ number: 4, created: false });
    expect(
      runner.calls.some(({ args }) => args[0] === "pr" && args[1] === "edit"),
    ).toBe(true);
    expect(
      runner.calls.some(({ args }) => args[0] === "pr" && args[1] === "create"),
    ).toBe(false);
  });

  it("recovers idempotently when concurrent creation reports a duplicate", async () => {
    let lists = 0;
    const runner = new FakeRunner((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        lists += 1;
        return {
          stdout:
            lists === 1
              ? "[]"
              : '[{"number":9,"url":"https://github.com/acme/repo/pull/9"}]',
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create")
        return { code: 1, stderr: "already exists" };
      return successful(command, args);
    });
    await expect(
      new GitHubAdapter(runner).createOrUpdatePullRequest({
        cwd: "/repo",
        repository: "acme/repo",
        remote: "origin",
        sourceBranch: "swf/run",
        targetBranch: "main",
        title: "Title",
        body: "Body",
      }),
    ).resolves.toMatchObject({ number: 9, created: false });
  });

  it("normalizes hosted checks, reviews, closure, and merge state", async () => {
    const runner = new FakeRunner(() => ({
      stdout: JSON.stringify({
        number: 3,
        url: "https://github.com/acme/repo/pull/3",
        state: "OPEN",
        mergeStateStatus: "BLOCKED",
        headRefName: "swf/run",
        baseRefName: "main",
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [
          {
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://example.test/check",
          },
        ],
        reviews: [
          {
            author: { login: "octocat" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-04-02T12:00:00.000Z",
          },
        ],
      }),
    }));
    await expect(
      new GitHubAdapter(runner).observePullRequest({
        cwd: "/repo",
        repository: "acme/repo",
        number: 3,
      }),
    ).resolves.toMatchObject({
      state: "open",
      mergeState: "BLOCKED",
      checks: [{ name: "test", conclusion: "FAILURE" }],
      reviews: [{ actor: "octocat", state: "CHANGES_REQUESTED" }],
    });
  });

  it("selects merge, squash, rebase, and repository-default operations", async () => {
    const runner = new FakeRunner(() => undefined);
    const adapter = new GitHubAdapter(runner);
    await adapter.requestAutoMerge({
      cwd: "/repo",
      repository: "acme/repo",
      number: 1,
      method: "squash",
    });
    await adapter.mergePullRequest({
      cwd: "/repo",
      repository: "acme/repo",
      number: 1,
      method: "merge",
    });
    await adapter.mergePullRequest({
      cwd: "/repo",
      repository: "acme/repo",
      number: 1,
      method: "rebase",
    });
    await adapter.mergePullRequest({
      cwd: "/repo",
      repository: "acme/repo",
      number: 1,
      method: "repository-default",
    });
    const mergeCalls = runner.calls.filter(
      ({ args }) => args[0] === "pr" && args[1] === "merge",
    );
    expect(mergeCalls[0]?.args).toContain("--squash");
    expect(mergeCalls[1]?.args).toContain("--merge");
    expect(mergeCalls[2]?.args).toContain("--rebase");
    expect(mergeCalls[3]?.args).not.toEqual(
      expect.arrayContaining(["--merge", "--squash", "--rebase"]),
    );
  });
});
