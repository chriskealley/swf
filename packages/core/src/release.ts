import { createHash } from "node:crypto";
import { ReleasePreflightSchema, type DocumentValue } from "./schemas.js";
import {
  assertSafeGitBranchName,
  assertSafeGitRemoteName,
} from "./security.js";
import type { CommandRunner, GitClient } from "./git.js";

export type ReleasePreflight = DocumentValue<"releasePreflight">;

export interface ReleasePreflightInput {
  runId: string;
  git: GitClient;
  runner: CommandRunner;
  sourceBranch: string;
  targetBranch: string;
  remote: string;
  mergeMethod: ReleasePreflight["mergeMethod"];
  expectedSourceCommit: string;
  expectedTargetCommit?: string;
  requireCleanSource?: boolean;
  refreshTarget?: boolean;
  policyChecks?: Array<{ id: string; passed: boolean; detail: string }>;
}

/** Deterministic, read-first release admission. It never merges or deletes anything. */
export async function releasePreflight(
  input: ReleasePreflightInput,
): Promise<ReleasePreflight> {
  const sourceBranch = assertSafeGitBranchName(input.sourceBranch);
  const targetBranch = assertSafeGitBranchName(input.targetBranch);
  const remote = assertSafeGitRemoteName(input.remote);
  const checks: ReleasePreflight["checks"] = [];
  const sourceStatus = await input.git.status();
  checks.push({
    id: "source-branch",
    status: sourceStatus.branch === sourceBranch ? "passed" : "failed",
    detail: `source branch is ${sourceStatus.branch}`,
  });
  checks.push({
    id: "source-checkpoint",
    status:
      sourceStatus.head === input.expectedSourceCommit ? "passed" : "failed",
    detail: `source checkpoint ${input.expectedSourceCommit}; current ${sourceStatus.head}`,
  });
  checks.push({
    id: "source-dirty",
    status:
      !input.requireCleanSource || sourceStatus.clean ? "passed" : "failed",
    detail: sourceStatus.clean
      ? "source worktree is clean"
      : "source worktree has uncommitted changes",
  });
  if (input.refreshTarget) {
    const fetched = await input.runner.run(
      "git",
      ["fetch", "--prune", "--", remote],
      { cwd: input.git.cwd },
    );
    checks.push({
      id: "target-refresh",
      status: fetched.code === 0 ? "passed" : "failed",
      detail:
        fetched.code === 0
          ? `refreshed ${remote}`
          : fetched.stderr.trim() || "target refresh failed",
    });
  } else
    checks.push({
      id: "target-refresh",
      status: "passed",
      detail: "target refresh was not requested",
    });
  const target = await input.runner.run("git", ["rev-parse", targetBranch], {
    cwd: input.git.cwd,
  });
  const targetCommit =
    target.code === 0 ? target.stdout.trim() : "unresolved-target";
  checks.push({
    id: "target-branch",
    status: target.code === 0 ? "passed" : "failed",
    detail:
      target.code === 0
        ? `${targetBranch} is ${targetCommit}`
        : target.stderr.trim() || "target branch is unavailable",
  });
  if (input.expectedTargetCommit)
    checks.push({
      id: "target-drift",
      status: targetCommit === input.expectedTargetCommit ? "passed" : "failed",
      detail: `expected target ${input.expectedTargetCommit}; current ${targetCommit}`,
    });
  const mergeCheck = await input.runner.run(
    "git",
    ["merge-tree", targetBranch, sourceBranch],
    { cwd: input.git.cwd },
  );
  checks.push({
    id: "merge-conflict",
    status: mergeCheck.code === 0 ? "passed" : "failed",
    detail:
      mergeCheck.code === 0
        ? "source merges cleanly into target"
        : mergeCheck.stdout.trim() ||
          mergeCheck.stderr.trim() ||
          "source and target conflict",
  });
  const remoteCheck = await input.runner.run(
    "git",
    ["remote", "get-url", "--", remote],
    { cwd: input.git.cwd },
  );
  checks.push({
    id: "remote",
    status: remoteCheck.code === 0 ? "passed" : "failed",
    detail:
      remoteCheck.code === 0
        ? `${remote} is configured`
        : remoteCheck.stderr.trim() || "remote is unavailable",
  });
  for (const policy of input.policyChecks ?? [])
    checks.push({
      id: policy.id,
      status: policy.passed ? "passed" : "failed",
      detail: policy.detail,
    });
  return ReleasePreflightSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    sourceBranch,
    targetBranch,
    sourceCommit: sourceStatus.head,
    targetCommit,
    remote,
    mergeMethod: input.mergeMethod,
    checks,
    valid: checks.every(({ status }) => status === "passed"),
    createdAt: new Date().toISOString(),
  });
}

export function releasePreflightFingerprint(value: ReleasePreflight): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function summarizeReleaseApproval(input: {
  preflight: ReleasePreflight;
  evidence: string[];
  risks: string[];
  cleanupPlan: string[];
}): string {
  return [
    `Source ${input.preflight.sourceBranch}@${input.preflight.sourceCommit}`,
    `target ${input.preflight.targetBranch}@${input.preflight.targetCommit}`,
    `merge method ${input.preflight.mergeMethod}`,
    `preflight ${input.preflight.valid ? "passed" : "blocked"}`,
    `evidence: ${input.evidence.join(", ") || "none"}`,
    `risks: ${input.risks.join(", ") || "none"}`,
    `cleanup: ${input.cleanupPlan.join(", ") || "retain owned resources"}`,
  ].join("; ");
}
