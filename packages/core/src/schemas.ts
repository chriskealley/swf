import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

const SchemaVersion = z.literal(CURRENT_SCHEMA_VERSION);
const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be kebab-case");
const IsoDateTime = z.string().datetime({ offset: true });
const JsonObject = z.record(z.string(), z.unknown());

export const HarnessSchema = z.enum(["pi", "codex", "claude", "copilot"]);
export const GateModeSchema = z.enum(["manual", "automatic", "advisory"]);
export const WorkUnitTypeSchema = z.enum([
  "agent",
  "command",
  "human",
  "openspec",
  "sequential",
]);
export const CheckTypeSchema = z.enum([
  "command",
  "agent",
  "human",
  "openspec",
]);

export const ProfileSchema = z.object({
  schemaVersion: SchemaVersion,
  id: Identifier,
  description: z.string().min(1),
  harness: HarnessSchema.optional(),
  model: z.string().min(1).optional(),
  guidelines: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  options: JsonObject.default({}),
});

export const GuidelineSchema = z.object({
  schemaVersion: SchemaVersion,
  id: Identifier,
  title: z.string().min(1),
  content: z.string().min(1),
});

export const PolicySchema = z.object({
  schemaVersion: SchemaVersion,
  id: Identifier,
  approvalMode: GateModeSchema,
  maxAttempts: z.number().int().positive().default(1),
  timeoutMinutes: z.number().int().positive().optional(),
  budgetUsd: z.number().nonnegative().optional(),
  riskOverrides: z.array(z.string().min(1)).default([]),
});

export const WorkUnitSchema = z.object({
  id: Identifier,
  type: WorkUnitTypeSchema,
  profile: Identifier.optional(),
  command: z.string().min(1).optional(),
  options: JsonObject.default({}),
});

export const CheckSchema = z.object({
  id: Identifier,
  type: CheckTypeSchema,
  required: z.boolean().default(true),
  command: z.string().min(1).optional(),
  profile: Identifier.optional(),
  options: JsonObject.default({}),
});

export const PhaseSchema = z.object({
  id: Identifier,
  title: z.string().min(1),
  profile: Identifier,
  guidelines: z.array(Identifier).default([]),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  work: z.array(WorkUnitSchema).default([]),
  checks: z.array(CheckSchema).default([]),
  gate: z.object({ mode: GateModeSchema }).default({ mode: "manual" }),
});

export const WorkflowSchema = z.object({
  schemaVersion: SchemaVersion,
  id: Identifier,
  description: z.string().min(1),
  phases: z.array(PhaseSchema).min(1),
  delivery: z.object({
    mode: z.enum(["pull-request", "local-branch", "direct-merge"]),
    mergeMethod: z.enum(["merge", "squash", "rebase", "repository-default"]),
  }),
});

export const ProjectConfigSchema = z.object({
  schemaVersion: SchemaVersion,
  projectId: z.string().uuid(),
  defaultWorkflow: Identifier,
  git: z.object({
    remote: z.string().min(1).default("origin"),
    targetBranch: z.string().min(1).default("main"),
  }),
  paths: z.object({
    state: z.literal(".swf-state"),
  }),
});

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "paused",
  "failed",
  "cancelled",
  "skipped",
  "completed",
]);
export const PhaseStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "failed",
  "cancelled",
  "skipped",
  "completed",
]);
export const AttemptStatusSchema = z.enum([
  "running",
  "blocked",
  "failed",
  "cancelled",
  "completed",
]);
export const WorkUnitStatusSchema = AttemptStatusSchema;
export const CheckStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
]);
export const GateStatusSchema = z.enum([
  "pending",
  "satisfied",
  "rejected",
  "blocked",
  "skipped",
]);

export const RunSchema = z.object({
  schemaVersion: SchemaVersion,
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  changeName: Identifier,
  workflowId: Identifier,
  changeIdentity: z.string().min(1).optional(),
  phaseIds: z.array(Identifier).optional(),
  description: z.string().min(1),
  status: RunStatusSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const EventActorSchema = z.object({
  type: z.enum(["system", "user", "policy", "harness", "service"]),
  id: z.string().min(1),
});
export const EventContextSchema = z.object({
  phaseId: Identifier.optional(),
  attemptId: z.string().uuid().optional(),
  workUnitId: Identifier.optional(),
  checkId: Identifier.optional(),
  invocationId: z.string().uuid().optional(),
});
export const EventTypeSchema = z.enum([
  "run.created",
  "run.transitioned",
  "phase.transitioned",
  "attempt.started",
  "attempt.completed",
  "work-unit.transitioned",
  "check.recorded",
  "gate.decided",
  "artifact.recorded",
  "invocation.recorded",
  "checkpoint.recorded",
  "delivery.recorded",
  "run.retried",
  "phase.rerun",
  "run.remediated",
  "run.reset",
  "run.rolled-back",
]);

export const EventSchema = z.object({
  schemaVersion: SchemaVersion,
  eventId: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: IsoDateTime,
  type: EventTypeSchema,
  actor: EventActorSchema,
  context: EventContextSchema.default({}),
  idempotencyKey: z.string().min(1).max(200).optional(),
  data: JsonObject,
});

export const SnapshotSchema = z.object({
  schemaVersion: SchemaVersion,
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  state: JsonObject,
});

export const InvocationSchema = z.object({
  schemaVersion: SchemaVersion,
  invocationId: z.string().uuid(),
  runId: z.string().uuid(),
  phaseId: Identifier,
  harness: HarnessSchema,
  status: RunStatusSchema,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
  outputRef: z.string().min(1).optional(),
  cost: z.object({
    amountUsd: z.number().nonnegative().optional(),
    quality: z.enum(["exact", "estimated", "unknown"]),
  }),
});

export const ArtifactSchema = z.object({
  schemaVersion: SchemaVersion,
  artifactId: z.string().uuid(),
  runId: z.string().uuid(),
  type: z.string().min(1),
  phaseId: Identifier,
  sourceCommit: z.string().min(1),
  inputFingerprint: z.string().min(1),
  status: z.enum(["valid", "stale", "invalid", "missing"]),
  createdAt: IsoDateTime,
  outputRef: z.string().min(1),
  producerAttemptId: z.string().uuid().optional(),
  rawOutputRef: z.string().min(1).optional(),
  summary: z.string().min(1).max(2_000).optional(),
  consumers: z.array(Identifier).default([]),
  invalidReason: z.string().min(1).optional(),
});

export const HandoffSchema = z.object({
  schemaVersion: SchemaVersion,
  handoffId: z.string().uuid(),
  runId: z.string().uuid(),
  phaseId: Identifier,
  summary: z.array(z.string().min(1)).min(1),
  decisions: z.array(z.string().min(1)).default([]),
  knownIssues: z.array(z.string().min(1)).default([]),
  recommendedNextActions: z.array(z.string().min(1)).default([]),
  artifactIds: z.array(z.string().uuid()).default([]),
  degraded: z.boolean().default(false),
});

export const ExplorationBriefSchema = z.object({
  schemaVersion: SchemaVersion,
  explorationId: z.string().uuid(),
  problem: z.string().min(1),
  goals: z.array(z.string().min(1)),
  nonGoals: z.array(z.string().min(1)),
  options: z.array(z.string().min(1)),
  decisions: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  codebaseFindings: z.array(z.string().min(1)),
  candidateScope: z.string().min(1),
  candidateChangeName: Identifier,
});

export const ExplorationSchema = z.object({
  schemaVersion: SchemaVersion,
  explorationId: z.string().uuid(),
  idea: z.string().min(1),
  status: z.enum(["active", "blocked", "completed", "cancelled", "discarded"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  brief: ExplorationBriefSchema.optional(),
});

export const ApprovalSchema = z.object({
  schemaVersion: SchemaVersion,
  approvalId: z.string().uuid(),
  runId: z.string().uuid(),
  phaseId: Identifier,
  decision: z.enum([
    "approved",
    "rejected",
    "auto-approved",
    "request-changes",
  ]),
  actor: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  createdAt: IsoDateTime,
  reason: z.string().min(1).optional(),
});

export const CheckpointSchema = z.object({
  schemaVersion: SchemaVersion,
  checkpointId: z.string().uuid(),
  runId: z.string().uuid(),
  phaseId: Identifier,
  beforeCommit: z.string().min(1),
  afterCommit: z.string().min(1),
  createdAt: IsoDateTime,
  logical: z.boolean(),
});

export const DeliverySchema = z.object({
  schemaVersion: SchemaVersion,
  deliveryId: z.string().uuid(),
  runId: z.string().uuid(),
  provider: z.literal("github"),
  status: z.enum(["pending", "awaiting-merge", "merged", "failed", "closed"]),
  pullRequestUrl: z.string().url().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase", "repository-default"]),
});

export const documents = {
  projectConfig: ProjectConfigSchema,
  workflow: WorkflowSchema,
  policy: PolicySchema,
  profile: ProfileSchema,
  guideline: GuidelineSchema,
  run: RunSchema,
  event: EventSchema,
  snapshot: SnapshotSchema,
  invocation: InvocationSchema,
  artifact: ArtifactSchema,
  handoff: HandoffSchema,
  exploration: ExplorationSchema,
  explorationBrief: ExplorationBriefSchema,
  approval: ApprovalSchema,
  checkpoint: CheckpointSchema,
  delivery: DeliverySchema,
} as const;

export type DocumentName = keyof typeof documents;
export type DocumentValue<T extends DocumentName> = z.infer<
  (typeof documents)[T]
>;

export const jsonSchemas = Object.fromEntries(
  Object.entries(documents).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
  ]),
) as Record<DocumentName, object>;

export function parseDocument<T extends DocumentName>(
  name: T,
  value: unknown,
): DocumentValue<T> {
  return documents[name].parse(value) as DocumentValue<T>;
}

export function validateJsonDocument<T extends DocumentName>(
  name: T,
  value: unknown,
) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const valid = ajv.validate(jsonSchemas[name], value);
  return { valid: Boolean(valid), errors: ajv.errors ?? [] };
}
