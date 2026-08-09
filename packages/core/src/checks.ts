import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Artifact } from "./domain.js";
import { type ArtifactStore } from "./artifacts.js";
import { type CommandRunner } from "./git.js";
import { ApprovalSchema, type DocumentValue } from "./schemas.js";

export type CheckKind = "command" | "openspec" | "agent" | "human";
export type EvidenceStatus = "passed" | "failed" | "blocked" | "cancelled";

export interface CheckEvidence {
  checkId: string;
  type: CheckKind;
  required: boolean;
  status: EvidenceStatus;
  artifact?: Artifact;
  deterministic: boolean;
  createdAt: string;
  summary: string;
}

export interface CommandCheckRequest {
  checkId: string;
  phaseId: string;
  command: string;
  args: string[];
  configuration?: unknown;
  commit: string;
  cwd?: string;
  timeoutMs?: number;
}

export async function runCommandCheck(input: {
  runner: CommandRunner;
  artifacts: ArtifactStore;
  request: CommandCheckRequest;
}): Promise<CheckEvidence> {
  const result = await input.runner.run(
    input.request.command,
    input.request.args,
    {
      cwd: input.request.cwd,
      timeoutMs: input.request.timeoutMs,
    },
  );
  const command = [input.request.command, ...input.request.args].join(" ");
  const captured = await input.artifacts.captureCommand({
    phaseId: input.request.phaseId,
    command,
    configuration: input.request.configuration ?? {},
    commit: input.request.commit,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return {
    checkId: input.request.checkId,
    type: "command",
    required: true,
    status: result.code === 0 ? "passed" : "failed",
    artifact: captured.artifact,
    deterministic: true,
    createdAt: captured.artifact.createdAt,
    summary: captured.result.summary,
  };
}

export async function runOpenSpecCheck(input: {
  runner: CommandRunner;
  artifacts: ArtifactStore;
  checkId: string;
  phaseId: string;
  changeName: string;
  commit: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CheckEvidence> {
  const command = "openspec validate";
  const result = await input.runner.run(
    "openspec",
    ["validate", input.changeName],
    {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    },
  );
  const captured = await input.artifacts.captureOpenSpecEvidence({
    phaseId: input.phaseId,
    commit: input.commit,
    command,
    exitCode: result.code,
    output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
  });
  return {
    checkId: input.checkId,
    type: "openspec",
    required: true,
    status: result.code === 0 ? "passed" : "failed",
    artifact: captured.artifact,
    deterministic: true,
    createdAt: captured.artifact.createdAt,
    summary: captured.evidence.summary,
  };
}

export const ReviewFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["info", "warning", "blocking"]),
    title: z.string().min(1),
    detail: z.string().min(1),
    artifactIds: z.array(z.string().uuid()).default([]),
  })
  .strict();
export const AgentReviewSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    findings: z.array(ReviewFindingSchema).default([]),
  })
  .strict();
export type AgentReview = z.infer<typeof AgentReviewSchema>;

export async function recordAgentReview(input: {
  artifacts: ArtifactStore;
  checkId: string;
  phaseId: string;
  commit: string;
  inputFingerprint: string;
  review: unknown;
}): Promise<CheckEvidence> {
  const review = AgentReviewSchema.parse(input.review);
  const artifactId = randomUUID();
  const outputRef = await input.artifacts.retainRaw(
    `reviews/${artifactId}.json`,
    `${JSON.stringify(review, null, 2)}\n`,
  );
  const artifact: Artifact = {
    schemaVersion: 1,
    artifactId,
    runId: input.artifacts.runId,
    type: "agent-review",
    phaseId: input.phaseId,
    sourceCommit: input.commit,
    inputFingerprint: input.inputFingerprint,
    status: "valid",
    createdAt: new Date().toISOString(),
    outputRef,
    rawOutputRef: outputRef,
    summary: review.summary,
    consumers: [],
  };
  await input.artifacts.record(artifact);
  const blockers = review.findings.filter(
    ({ severity }) => severity === "blocking",
  );
  return {
    checkId: input.checkId,
    type: "agent",
    required: true,
    status: blockers.length ? "failed" : "passed",
    artifact,
    // Schema-valid agent review is still narrative, not deterministic evidence.
    deterministic: false,
    createdAt: artifact.createdAt,
    summary: blockers.length
      ? `${blockers.length} blocking finding(s): ${review.summary}`
      : review.summary,
  };
}

export type ApprovalDecision = DocumentValue<"approval">;
export interface ApprovalAuthorization {
  authorizationId: string;
  delegatedBy: { type: "user"; id: string };
  scope: "gate" | "phase" | "run" | "workflow" | "project";
  scopeId: string;
  acknowledgedAt: string;
  configurationSource: string;
  expiresAt?: string;
}

export function recordHumanApproval(input: {
  runId: string;
  phaseId: string;
  actor: { type: string; id: string };
  decision: "approved" | "rejected" | "request-changes";
  reason?: string;
  evidenceArtifactIds?: string[];
}): ApprovalDecision {
  return ApprovalSchema.parse({
    schemaVersion: 1,
    approvalId: randomUUID(),
    runId: input.runId,
    phaseId: input.phaseId,
    decision: input.decision,
    actor: input.actor,
    createdAt: new Date().toISOString(),
    reason: input.reason,
    evidenceArtifactIds: input.evidenceArtifactIds ?? [],
  });
}

export function recordAutoApproval(input: {
  runId: string;
  phaseId: string;
  authorization: ApprovalAuthorization;
  reason: string;
  now?: Date;
}): ApprovalDecision {
  const now = input.now ?? new Date();
  if (
    input.authorization.expiresAt &&
    new Date(input.authorization.expiresAt) <= now
  )
    throw new Error("Delegated authorization has expired");
  return ApprovalSchema.parse({
    schemaVersion: 1,
    approvalId: randomUUID(),
    runId: input.runId,
    phaseId: input.phaseId,
    decision: "auto-approved",
    actor: { type: "policy", id: "swf-policy" },
    createdAt: now.toISOString(),
    reason: input.reason,
    evidenceArtifactIds: [],
    authorization: input.authorization,
  });
}

export function humanApprovalEvidence(input: {
  checkId: string;
  approval: ApprovalDecision;
  required?: boolean;
}): CheckEvidence {
  return {
    checkId: input.checkId,
    type: "human",
    required: input.required ?? true,
    status:
      input.approval.decision === "approved" ||
      input.approval.decision === "auto-approved"
        ? "passed"
        : input.approval.decision === "rejected"
          ? "failed"
          : "blocked",
    deterministic: true,
    createdAt: input.approval.createdAt,
    summary: input.approval.reason ?? input.approval.decision,
  };
}

export interface GateDefinition {
  mode: "all" | "any" | "threshold" | "advisory";
  requiredCheckIds?: string[];
  threshold?: number;
}
export interface GateDecision {
  status: "satisfied" | "rejected" | "blocked" | "skipped";
  reasons: string[];
  validEvidence: string[];
}

function evidenceIsValid(evidence: CheckEvidence): boolean {
  if (!evidence.deterministic) return false;
  // Human approvals are durable decisions rather than output artifacts.
  if (evidence.type === "human") return true;
  return (
    evidence.artifact !== undefined &&
    evidence.artifact.status !== "stale" &&
    evidence.artifact.status !== "invalid" &&
    evidence.artifact.status !== "missing"
  );
}

export function evaluateGate(
  definition: GateDefinition,
  evidence: CheckEvidence[],
): GateDecision {
  if (definition.mode === "advisory")
    return {
      status: "skipped",
      reasons: ["Advisory gate does not block transition"],
      validEvidence: [],
    };
  const required = definition.requiredCheckIds
    ? definition.requiredCheckIds.map(
        (id) =>
          evidence.find((entry) => entry.checkId === id) ?? {
            checkId: id,
            type: "command" as const,
            required: true,
            status: "blocked" as const,
            deterministic: false,
            createdAt: "",
            summary: "Missing evidence",
          },
      )
    : evidence.filter(({ required }) => required);
  const validPassed = required.filter(
    (entry) => entry.status === "passed" && evidenceIsValid(entry),
  );
  const invalid = required.filter(
    (entry) => entry.status === "passed" && !evidenceIsValid(entry),
  );
  const failures = required.filter((entry) => entry.status === "failed");
  const reasons = [
    ...invalid.map(
      ({ checkId }) =>
        `Check ${checkId} has stale, invalid, missing, or narrative-only evidence`,
    ),
    ...failures.map(({ checkId }) => `Check ${checkId} failed`),
    ...required
      .filter(({ status }) => status === "blocked" || status === "cancelled")
      .map(({ checkId }) => `Check ${checkId} is incomplete`),
  ];
  const passed = validPassed.length;
  const satisfied =
    definition.mode === "all"
      ? passed === required.length
      : definition.mode === "any"
        ? passed > 0
        : passed >= (definition.threshold ?? 1);
  return {
    status: satisfied ? "satisfied" : failures.length ? "rejected" : "blocked",
    reasons: satisfied
      ? []
      : reasons.length
        ? reasons
        : ["Gate requirements are not satisfied"],
    validEvidence: validPassed.map(({ checkId }) => checkId),
  };
}

export interface RiskAssessmentInput {
  changedFiles?: string[];
  sensitivePathPatterns?: string[];
  destructiveOperation?: boolean;
  secretsFound?: boolean;
  elevatedRisk?: boolean;
  spendUsd?: number;
  budgetThresholdUsd?: number;
}

function matchesPattern(path: string, pattern: string): boolean {
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*")}$`;
  return new RegExp(expression).test(path);
}

export function assessRiskOverride(input: RiskAssessmentInput): string[] {
  const reasons: string[] = [];
  if (
    input.changedFiles?.some((file) =>
      input.sensitivePathPatterns?.some((pattern) =>
        matchesPattern(file, pattern),
      ),
    )
  )
    reasons.push("sensitive path changed");
  if (input.destructiveOperation) reasons.push("destructive operation");
  if (input.secretsFound) reasons.push("secret finding");
  if (input.elevatedRisk) reasons.push("elevated risk");
  if (
    input.budgetThresholdUsd !== undefined &&
    (input.spendUsd ?? 0) >= input.budgetThresholdUsd
  )
    reasons.push("budget threshold reached");
  return reasons;
}

export function resolveApprovalMode(input: {
  configured: "manual" | "automatic";
  risk: RiskAssessmentInput;
}): { mode: "manual" | "automatic"; reasons: string[] } {
  const reasons = assessRiskOverride(input.risk);
  return reasons.length
    ? { mode: "manual", reasons }
    : { mode: input.configured, reasons: [] };
}

export interface RetryPolicy {
  maxAttempts: number;
  maxElapsedMs?: number;
  maxSpendUsd?: number;
}
export function retryDecision(input: {
  policy: RetryPolicy;
  attempts: number;
  elapsedMs: number;
  spendUsd: number;
}): { retry: boolean; reason?: string } {
  if (input.attempts >= input.policy.maxAttempts)
    return { retry: false, reason: "attempt limit reached" };
  if (
    input.policy.maxElapsedMs !== undefined &&
    input.elapsedMs >= input.policy.maxElapsedMs
  )
    return { retry: false, reason: "elapsed-time limit reached" };
  if (
    input.policy.maxSpendUsd !== undefined &&
    input.spendUsd >= input.policy.maxSpendUsd
  )
    return { retry: false, reason: "spend limit reached" };
  return { retry: true };
}

/** Runs a declared check without changing containing phase or gate state. */
export async function refreshCheck(
  input: Parameters<typeof runCommandCheck>[0],
): Promise<CheckEvidence> {
  return runCommandCheck(input);
}
