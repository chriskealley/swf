import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  assessRiskOverride,
  evaluateGate,
  humanApprovalEvidence,
  recordAgentReview,
  recordAutoApproval,
  recordHumanApproval,
  resolveApprovalMode,
  refreshCheck,
  retryDecision,
  runCommandCheck,
  runOpenSpecCheck,
  type CommandOptions,
  type CommandRunner,
  type ProcessResult,
} from "../src/index.js";

const directories: string[] = [];
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "swf-checks-"));
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

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  constructor(
    readonly code = 0,
    readonly stdout = "ok",
  ) {}
  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args });
    return {
      code: this.code,
      stdout: this.stdout,
      stderr: this.code ? "failed" : "",
    };
  }
}

async function commandEvidence() {
  const root = await temporaryDirectory();
  return runCommandCheck({
    runner: new FakeRunner(),
    artifacts: new ArtifactStore(root, runId),
    request: {
      checkId: "unit",
      phaseId: "verifying",
      command: "pnpm",
      args: ["test"],
      commit: "abc",
    },
  });
}

describe("deterministic checks", () => {
  it("records command and OpenSpec checks as deterministic artifacts and supports independent refresh", async () => {
    const root = await temporaryDirectory();
    const artifacts = new ArtifactStore(root, runId);
    const runner = new FakeRunner();
    const command = await runCommandCheck({
      runner,
      artifacts,
      request: {
        checkId: "unit",
        phaseId: "verifying",
        command: "pnpm",
        args: ["test"],
        commit: "abc",
        configuration: { node: 22 },
      },
    });
    const openspec = await runOpenSpecCheck({
      runner,
      artifacts,
      checkId: "spec",
      phaseId: "planning",
      changeName: "add-user-auth",
      commit: "abc",
    });
    const refreshed = await refreshCheck({
      runner,
      artifacts,
      request: {
        checkId: "unit",
        phaseId: "verifying",
        command: "pnpm",
        args: ["test"],
        commit: "abc",
      },
    });
    expect(command).toMatchObject({
      status: "passed",
      deterministic: true,
      artifact: { type: "command-result" },
    });
    expect(openspec).toMatchObject({
      status: "passed",
      artifact: { type: "openspec-validation" },
    });
    expect(refreshed.checkId).toBe("unit");
    expect(runner.calls).toContainEqual({
      command: "openspec",
      args: ["validate", "add-user-auth"],
    });
  });

  it("validates agent review findings but never lets narrative-only evidence satisfy a required gate", async () => {
    const root = await temporaryDirectory();
    const review = await recordAgentReview({
      artifacts: new ArtifactStore(root, runId),
      checkId: "review",
      phaseId: "reviewing",
      commit: "abc",
      inputFingerprint: "review-input",
      review: {
        summary: "Needs changes",
        findings: [
          {
            id: "one",
            severity: "blocking",
            title: "Missing test",
            detail: "No coverage",
          },
        ],
      },
    });
    expect(review).toMatchObject({ status: "failed", deterministic: false });
    expect(
      evaluateGate({ mode: "all" }, [{ ...review, status: "passed" }]).status,
    ).toBe("blocked");
    await expect(
      recordAgentReview({
        artifacts: new ArtifactStore(root, runId),
        checkId: "review",
        phaseId: "reviewing",
        commit: "abc",
        inputFingerprint: "bad",
        review: { summary: "bad", findings: [{ severity: "critical" }] },
      }),
    ).rejects.toThrow();
  });
});

describe("gates and approvals", () => {
  it("evaluates all, any, threshold, advisory, stale evidence, and human approval decisions", async () => {
    const passed = await commandEvidence();
    const failed = { ...passed, checkId: "lint", status: "failed" as const };
    expect(evaluateGate({ mode: "all" }, [passed]).status).toBe("satisfied");
    expect(evaluateGate({ mode: "all" }, [passed, failed]).status).toBe(
      "rejected",
    );
    expect(evaluateGate({ mode: "any" }, [passed, failed]).status).toBe(
      "satisfied",
    );
    expect(
      evaluateGate({ mode: "threshold", threshold: 2 }, [passed, failed])
        .status,
    ).toBe("rejected");
    expect(evaluateGate({ mode: "advisory" }, [failed]).status).toBe("skipped");
    expect(
      evaluateGate({ mode: "all", requiredCheckIds: ["approver"] }, []),
    ).toMatchObject({ status: "blocked" });
    const stale = {
      ...passed,
      artifact: { ...passed.artifact!, status: "stale" as const },
    };
    expect(evaluateGate({ mode: "all" }, [stale]).status).toBe("blocked");

    const rejected = humanApprovalEvidence({
      checkId: "approval",
      approval: recordHumanApproval({
        runId,
        phaseId: "releasing",
        actor: { type: "user", id: "alex" },
        decision: "rejected",
        reason: "wait",
      }),
    });
    expect(evaluateGate({ mode: "all" }, [rejected]).status).toBe("rejected");
    const automatic = humanApprovalEvidence({
      checkId: "approval",
      approval: recordAutoApproval({
        runId,
        phaseId: "releasing",
        reason: "autonomous policy",
        authorization: {
          authorizationId: "5c0e81cf-4043-46e5-9c4d-139a79decbef",
          delegatedBy: { type: "user", id: "alex" },
          scope: "run",
          scopeId: runId,
          acknowledgedAt: "2026-04-02T12:00:00.000Z",
          configurationSource: ".swf/policies/autonomous.json",
        },
      }),
    });
    expect(automatic).toMatchObject({
      status: "passed",
      summary: "autonomous policy",
    });
    expect(evaluateGate({ mode: "all" }, [automatic]).status).toBe("satisfied");
  });

  it("fails closed for expired authorizations and applies risk overrides and bounded remediation", () => {
    expect(() =>
      recordAutoApproval({
        runId,
        phaseId: "releasing",
        reason: "expired",
        now: new Date("2026-04-03T00:00:00.000Z"),
        authorization: {
          authorizationId: "5c0e81cf-4043-46e5-9c4d-139a79decbef",
          delegatedBy: { type: "user", id: "alex" },
          scope: "run",
          scopeId: runId,
          acknowledgedAt: "2026-04-01T00:00:00.000Z",
          configurationSource: "policy",
          expiresAt: "2026-04-02T00:00:00.000Z",
        },
      }),
    ).toThrow("expired");
    const risk = {
      changedFiles: ["infra/prod.tf"],
      sensitivePathPatterns: ["infra/**"],
      destructiveOperation: true,
      secretsFound: true,
      elevatedRisk: true,
      spendUsd: 10,
      budgetThresholdUsd: 10,
    };
    expect(assessRiskOverride(risk)).toEqual([
      "sensitive path changed: infra/prod.tf matches infra/**",
      "destructive operation",
      "secret finding",
      "elevated risk",
      "budget threshold reached",
    ]);
    const resolved = resolveApprovalMode({ configured: "automatic", risk });
    expect(resolved.mode).toBe("manual");
    expect(resolved.reasons).toContain(
      "sensitive path changed: infra/prod.tf matches infra/**",
    );
    expect(
      retryDecision({
        policy: { maxAttempts: 2 },
        attempts: 2,
        elapsedMs: 0,
        spendUsd: 0,
      }),
    ).toMatchObject({ retry: false, reason: "attempt limit reached" });
    expect(
      retryDecision({
        policy: { maxAttempts: 3, maxElapsedMs: 10 },
        attempts: 1,
        elapsedMs: 10,
        spendUsd: 0,
      }).reason,
    ).toBe("elapsed-time limit reached");
    expect(
      retryDecision({
        policy: { maxAttempts: 3, maxSpendUsd: 5 },
        attempts: 1,
        elapsedMs: 0,
        spendUsd: 5,
      }).reason,
    ).toBe("spend limit reached");
  });
});

/** The four patterns hard-coded in apps/service/src/server/swf-service.ts. */
const shippedSensitivePatterns = [
  ".github/**",
  "**/security/**",
  "**/auth/**",
  "infra/**",
];

function sensitive(changedFiles: string[], sensitivePathPatterns: string[]) {
  return assessRiskOverride({ changedFiles, sensitivePathPatterns }).some(
    (reason) => reason.startsWith("sensitive path changed"),
  );
}

describe("sensitive path glob matching", () => {
  it("matches a nested path under a prefix rule", () => {
    expect(sensitive(["infra/prod.tf"], ["infra/**"])).toBe(true);
    expect(sensitive(["infra/aws/prod/main.tf"], ["infra/**"])).toBe(true);
  });

  it("matches a dotted configuration directory", () => {
    expect(sensitive([".github/workflows/ci.yml"], [".github/**"])).toBe(true);
  });

  it("matches a leading wildcard at any depth", () => {
    expect(sensitive(["src/security/token.ts"], ["**/security/**"])).toBe(true);
    expect(sensitive(["app/api/security/token.ts"], ["**/security/**"])).toBe(
      true,
    );
  });

  it("matches a leading wildcard spanning zero segments", () => {
    expect(sensitive(["security/token.ts"], ["**/security/**"])).toBe(true);
  });

  it("does not let a single wildcard span path separators", () => {
    expect(sensitive(["infra/aws/prod/main.tf"], ["infra/*"])).toBe(false);
    expect(sensitive(["infra/prod.tf"], ["infra/*"])).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(sensitive(["src/app.ts"], shippedSensitivePatterns)).toBe(false);
    expect(sensitive(["docs/readme.md"], shippedSensitivePatterns)).toBe(false);
    expect(sensitive(["insecurity/token.ts"], ["**/security/**"])).toBe(false);
  });

  it("normalizes leading ./ and trailing slashes before matching", () => {
    expect(sensitive(["./infra/aws/main.tf"], ["infra/**"])).toBe(true);
    expect(sensitive(["infra/aws/"], ["infra/**"])).toBe(true);
  });

  it("fails closed when a pattern cannot be evaluated", () => {
    expect(sensitive(["src/app.ts"], ["[unterminated"])).toBe(true);
    expect(sensitive(["src/app.ts"], ["{unclosed"])).toBe(true);
    expect(sensitive(["src/app.ts"], ["infra/(a|b"])).toBe(true);
    expect(sensitive(["src/app.ts"], [""])).toBe(true);
  });

  it("still evaluates well-formed patterns containing delimiters", () => {
    expect(sensitive(["infra/prod.tf"], ["infra/*.{tf,tfvars}"])).toBe(true);
    expect(sensitive(["infra/prod.json"], ["infra/*.{tf,tfvars}"])).toBe(false);
    expect(sensitive(["src/a1.ts"], ["src/[a-z][0-9].ts"])).toBe(true);
    expect(sensitive(["src/escaped[1].ts"], ["src/escaped\\[1\\].ts"])).toBe(
      true,
    );
  });

  it("names the matched rule and path in the risk reason", () => {
    expect(
      assessRiskOverride({
        changedFiles: ["src/app.ts", ".github/workflows/ci.yml"],
        sensitivePathPatterns: shippedSensitivePatterns,
      }),
    ).toEqual([
      "sensitive path changed: .github/workflows/ci.yml matches .github/**",
    ]);
  });

  it("matches every shipped default pattern against realistic paths", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "app/api/security/token.ts",
      "security/token.ts",
      "packages/core/src/auth/session.ts",
      "infra/aws/prod/main.tf",
    ])
      expect(sensitive([file], shippedSensitivePatterns)).toBe(true);
  });
});
