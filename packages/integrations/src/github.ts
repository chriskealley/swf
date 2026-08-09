import {
  type CommandRunner,
  NodeCommandRunner,
  type HostingAdapter,
  type HostingPreflightCheck,
  type HostingPreflightInput,
  type HostingPreflightResult,
  type MergeMethod,
  type PullRequestObservation,
  type PullRequestReference,
  type PullRequestRequest,
} from "@swf/core";

interface RepositoryView {
  nameWithOwner: string;
  viewerPermission?: string;
  mergeCommitAllowed?: boolean;
  squashMergeAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
  autoMergeAllowed?: boolean;
}

interface PullRequestJson {
  number: number;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  state?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  autoMergeRequest?: unknown;
  statusCheckRollup?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

export function githubRepositoryFromRemote(
  remoteUrl: string,
): string | undefined {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const match = normalized.match(
    /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([^/]+\/[^/]+)$/i,
  );
  return match?.[1];
}

function methodFlag(method: MergeMethod): string[] {
  return method === "repository-default" ? [] : [`--${method}`];
}

function permissionAtLeastWrite(permission?: string): boolean {
  return ["ADMIN", "MAINTAIN", "WRITE"].includes(
    permission?.toUpperCase() ?? "",
  );
}

export class GitHubCommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(
      `${command} ${args.join(" ")} failed: ${stderr.trim() || "unknown error"}`,
    );
    this.name = "GitHubCommandError";
  }
}

export class GitHubAdapter implements HostingAdapter {
  readonly id = "github";

  constructor(readonly runner: CommandRunner = new NodeCommandRunner()) {}

  private async execute(
    command: string,
    args: string[],
    cwd: string,
    allowFailure = false,
  ) {
    const result = await this.runner.run(command, args, {
      cwd,
      timeoutMs: 30_000,
    });
    if (!allowFailure && result.code !== 0)
      throw new GitHubCommandError(command, args, result.stderr);
    return result;
  }

  async preflight(
    input: HostingPreflightInput,
  ): Promise<HostingPreflightResult> {
    if (input.mode === "local-branch")
      return {
        valid: true,
        skipped: true,
        checks: [
          {
            id: "remote",
            status: "skipped",
            detail: "Explicit local-branch delivery bypasses GitHub preflight",
          },
        ],
      };

    const checks: HostingPreflightCheck[] = [];
    const remote = await this.execute(
      "git",
      ["remote", "get-url", input.remote],
      input.cwd,
      true,
    );
    if (remote.code !== 0) {
      checks.push({
        id: "remote",
        status: "failed",
        detail: `Git remote ${input.remote} is not configured`,
        remediation: `Configure ${input.remote} or explicitly select local-branch delivery`,
      });
      return { valid: false, skipped: false, checks };
    }
    checks.push({
      id: "remote",
      status: "passed",
      detail: `${input.remote}: ${remote.stdout.trim()}`,
    });
    const repository = githubRepositoryFromRemote(remote.stdout);
    if (!repository) {
      checks.push({
        id: "repository",
        status: "failed",
        detail: `Remote ${input.remote} is not a GitHub repository`,
        remediation:
          "Configure a github.com remote or explicitly select local-branch delivery",
      });
      return { valid: false, skipped: false, checks };
    }
    checks.push({ id: "repository", status: "passed", detail: repository });

    const network = await this.execute(
      "gh",
      ["api", "rate_limit", "--silent"],
      input.cwd,
      true,
    );
    checks.push(
      network.code === 0
        ? { id: "network", status: "passed", detail: "GitHub API is reachable" }
        : {
            id: "network",
            status: "failed",
            detail: "GitHub API is unreachable",
            remediation: "Check network access and GitHub availability",
          },
    );

    const target = await this.execute(
      "git",
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        input.remote,
        `refs/heads/${input.targetBranch}`,
      ],
      input.cwd,
      true,
    );
    checks.push(
      target.code === 0
        ? {
            id: "target-branch",
            status: "passed",
            detail: `${input.remote}/${input.targetBranch} exists`,
          }
        : {
            id: "target-branch",
            status: "failed",
            detail: `Target branch ${input.targetBranch} cannot be resolved on ${input.remote}`,
            remediation: "Correct the configured target branch",
          },
    );

    const authentication = await this.execute(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      input.cwd,
      true,
    );
    checks.push(
      authentication.code === 0
        ? {
            id: "authentication",
            status: "passed",
            detail: "GitHub CLI authentication is valid",
          }
        : {
            id: "authentication",
            status: "failed",
            detail: "GitHub CLI authentication is invalid",
            remediation: "Run gh auth login --hostname github.com",
          },
    );

    let view: RepositoryView | undefined;
    const repositoryView = await this.execute(
      "gh",
      [
        "repo",
        "view",
        repository,
        "--json",
        "nameWithOwner,viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,autoMergeAllowed",
      ],
      input.cwd,
      true,
    );
    if (repositoryView.code === 0)
      view = parseJson<RepositoryView>(repositoryView.stdout, "gh repo view");
    const canWrite = permissionAtLeastWrite(view?.viewerPermission);
    checks.push(
      canWrite
        ? {
            id: "pull-request",
            status: "passed",
            detail: `Repository permission: ${view?.viewerPermission}`,
          }
        : {
            id: "pull-request",
            status: "failed",
            detail: "Pull-request creation permission is unavailable",
            remediation: "Request write access to the GitHub repository",
          },
    );

    const source = await this.execute(
      "git",
      ["rev-parse", "--verify", input.sourceBranch],
      input.cwd,
      true,
    );
    const push = await this.execute(
      "git",
      [
        "push",
        "--dry-run",
        input.remote,
        `${source.code === 0 ? input.sourceBranch : "HEAD"}:refs/heads/${input.sourceBranch}`,
      ],
      input.cwd,
      true,
    );
    checks.push(
      push.code === 0
        ? {
            id: "push",
            status: "passed",
            detail: `Can push ${input.sourceBranch} to ${input.remote}`,
          }
        : {
            id: "push",
            status: "failed",
            detail: "Branch push permission is unavailable",
            remediation: "Verify Git credentials and branch push permission",
          },
    );

    checks.push(
      input.requireMergePermission
        ? canWrite
          ? {
              id: "merge",
              status: "passed",
              detail: "Merge permission is available",
            }
          : {
              id: "merge",
              status: "failed",
              detail: "Required merge permission is unavailable",
              remediation:
                "Request repository merge permission or use manual delivery",
            }
        : {
            id: "merge",
            status: "skipped",
            detail: "Manual delivery does not require SWF merge permission",
          },
    );
    checks.push(
      input.requireAutoMerge
        ? view?.autoMergeAllowed
          ? {
              id: "auto-merge",
              status: "passed",
              detail: "Repository supports auto-merge",
            }
          : {
              id: "auto-merge",
              status: "failed",
              detail: "Repository does not support auto-merge",
              remediation:
                "Enable repository auto-merge or select manual delivery",
            }
        : {
            id: "auto-merge",
            status: "skipped",
            detail: "Auto-merge was not requested",
          },
    );

    return {
      valid: checks.every(({ status }) => status !== "failed"),
      skipped: false,
      repository,
      checks,
    };
  }

  private async findPullRequest(
    input: PullRequestRequest,
  ): Promise<PullRequestJson | undefined> {
    const result = await this.execute(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        input.repository,
        "--head",
        input.sourceBranch,
        "--base",
        input.targetBranch,
        "--state",
        "open",
        "--json",
        "number,url,headRefName,baseRefName",
        "--limit",
        "1",
      ],
      input.cwd,
    );
    return parseJson<PullRequestJson[]>(result.stdout, "gh pr list")[0];
  }

  async createOrUpdatePullRequest(
    input: PullRequestRequest,
  ): Promise<PullRequestReference> {
    await this.execute(
      "git",
      ["push", "--set-upstream", input.remote, input.sourceBranch],
      input.cwd,
    );
    const existing = await this.findPullRequest(input);
    if (existing) {
      await this.execute(
        "gh",
        [
          "pr",
          "edit",
          String(existing.number),
          "--repo",
          input.repository,
          "--title",
          input.title,
          "--body",
          input.body,
        ],
        input.cwd,
      );
      return {
        number: existing.number,
        url: existing.url,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        created: false,
      };
    }
    const created = await this.execute(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        input.repository,
        "--head",
        input.sourceBranch,
        "--base",
        input.targetBranch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      input.cwd,
      true,
    );
    if (created.code !== 0) {
      const raced = await this.findPullRequest(input);
      if (!raced)
        throw new GitHubCommandError("gh", ["pr", "create"], created.stderr);
      return {
        number: raced.number,
        url: raced.url,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        created: false,
      };
    }
    const pullRequest = await this.findPullRequest(input);
    if (!pullRequest)
      throw new Error(
        "GitHub created the pull request but it could not be queried",
      );
    return {
      number: pullRequest.number,
      url: pullRequest.url || created.stdout.trim(),
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      created: true,
    };
  }

  async observePullRequest(input: {
    cwd: string;
    repository: string;
    number: number;
  }): Promise<PullRequestObservation> {
    const result = await this.execute(
      "gh",
      [
        "pr",
        "view",
        String(input.number),
        "--repo",
        input.repository,
        "--json",
        "number,url,state,mergeStateStatus,reviewDecision,mergedAt,closedAt,headRefName,baseRefName,statusCheckRollup,reviews,autoMergeRequest",
      ],
      input.cwd,
    );
    const value = parseJson<PullRequestJson>(result.stdout, "gh pr view");
    const checks = (value.statusCheckRollup ?? []).map((check) => ({
      name: String(check.name ?? check.context ?? "hosted-check"),
      status: String(check.status ?? check.state ?? "unknown"),
      conclusion:
        typeof check.conclusion === "string" ? check.conclusion : undefined,
      url:
        typeof check.detailsUrl === "string"
          ? check.detailsUrl
          : typeof check.targetUrl === "string"
            ? check.targetUrl
            : undefined,
    }));
    const reviews = (value.reviews ?? []).map((review) => {
      const author = review.author as Record<string, unknown> | undefined;
      return {
        actor: String(author?.login ?? "unknown"),
        state: String(review.state ?? "unknown"),
        submittedAt:
          typeof review.submittedAt === "string"
            ? review.submittedAt
            : undefined,
      };
    });
    const state = value.mergedAt
      ? "merged"
      : value.state?.toUpperCase() === "CLOSED"
        ? "closed"
        : "open";
    return {
      number: value.number,
      url: value.url,
      sourceBranch: value.headRefName ?? "unknown",
      targetBranch: value.baseRefName ?? "unknown",
      created: false,
      state,
      mergeState: value.mergeStateStatus ?? "UNKNOWN",
      reviewDecision: value.reviewDecision,
      checks,
      reviews,
      autoMergeEnabled: value.autoMergeRequest != null,
    };
  }

  async requestAutoMerge(input: {
    cwd: string;
    repository: string;
    number: number;
    method: MergeMethod;
  }): Promise<void> {
    await this.execute(
      "gh",
      [
        "pr",
        "merge",
        String(input.number),
        "--repo",
        input.repository,
        "--auto",
        ...methodFlag(input.method),
      ],
      input.cwd,
    );
  }

  async mergePullRequest(input: {
    cwd: string;
    repository: string;
    number: number;
    method: MergeMethod;
  }): Promise<void> {
    await this.execute(
      "gh",
      [
        "pr",
        "merge",
        String(input.number),
        "--repo",
        input.repository,
        ...methodFlag(input.method),
      ],
      input.cwd,
    );
  }

  async directMerge(input: {
    cwd: string;
    repository: string;
    sourceBranch: string;
    targetBranch: string;
    method: MergeMethod;
  }): Promise<void> {
    const args = [
      "api",
      "--method",
      "POST",
      `repos/${input.repository}/merges`,
      "-f",
      `base=${input.targetBranch}`,
      "-f",
      `head=${input.sourceBranch}`,
    ];
    if (input.method !== "repository-default")
      args.push("-f", `merge_method=${input.method}`);
    await this.execute("gh", args, input.cwd);
  }

  async cleanupBranch(input: {
    cwd: string;
    remote: string;
    branch: string;
  }): Promise<void> {
    const result = await this.execute(
      "git",
      ["push", input.remote, "--delete", input.branch],
      input.cwd,
      true,
    );
    if (
      result.code !== 0 &&
      !/remote ref does not exist|unable to delete/i.test(result.stderr)
    )
      throw new GitHubCommandError(
        "git",
        ["push", input.remote, "--delete", input.branch],
        result.stderr,
      );
  }
}
