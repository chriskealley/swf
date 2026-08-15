import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

const SchemaVersion = z.literal(CURRENT_SCHEMA_VERSION);
const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be kebab-case");
const IsoDateTime = z.string().datetime({ offset: true });
const JsonObject = z.record(z.string(), z.unknown());
const BudgetLimitSchema = z.object({
  maxCostUsd: z.number().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  strictUnknown: z.boolean().default(true),
});

export const HarnessSchema = z.enum(["pi", "codex", "claude", "copilot"]);
export const ModelTierSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const ModelMappingSchema = z.object({
  model: z.string().min(1).optional(),
  fallback: z.array(z.string().min(1)).default([]),
  allowHarnessDefault: z.boolean().default(false),
  capabilities: z.array(z.string().min(1)).default([]),
});
export const ModelRouteSchema = z.object({
  harness: z.string().min(1),
  modelTier: ModelTierSchema.optional(),
  model: z.string().min(1).optional(),
  source: z.string().min(1),
  overriddenSources: z.array(z.string().min(1)).default([]),
  fallback: z.string().min(1).optional(),
  allowHarnessDefault: z.boolean().default(false),
  mappingPath: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
});
export const ModelRoutingSchema = z.object({
  schemaVersion: SchemaVersion,
  modelTiers: z.record(
    ModelTierSchema,
    z.record(z.string(), ModelMappingSchema),
  ),
});
export const PhaseContractSchema = z.object({
  schemaVersion: SchemaVersion,
  objective: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  allowedScope: z.array(z.string().min(1)).default([]),
  prohibitedActions: z.array(z.string().min(1)).default([]),
  requiredInputs: z.array(z.string().min(1)).default([]),
  requiredOutputs: z.array(z.string().min(1)).default([]),
  completionCriteria: z.array(z.string().min(1)).min(1),
  handoffExpectations: z.array(z.string().min(1)).default([]),
});
export const TaskAuditEntrySchema = z.object({
  taskId: z.string().min(1),
  text: z.string().min(1),
  checked: z.boolean(),
  implementationRefs: z.array(z.string().min(1)).default([]),
  checkIds: z.array(z.string().min(1)).default([]),
  evidenceFresh: z.boolean(),
  reviewBlockers: z.array(z.string().min(1)).default([]),
  conclusion: z.enum(["verified", "unverified", "blocked"]),
  reason: z.string().min(1).optional(),
});
export const TaskAuditSchema = z.object({
  schemaVersion: SchemaVersion,
  sourceCommit: z.string().min(1),
  tasksPath: z.string().min(1),
  entries: z.array(TaskAuditEntrySchema),
  status: z.enum(["verified", "blocked", "failed"]),
  summary: z.string().min(1),
});
export const ReviewFindingResolutionSchema = z.object({
  findingId: z.string().min(1),
  status: z.enum(["open", "resolved", "waived"]),
  evidenceArtifactIds: z.array(z.string().uuid()).default([]),
  sourceCommit: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});
export const ReleasePreflightSchema = z.object({
  schemaVersion: SchemaVersion,
  runId: z.string().uuid(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  sourceCommit: z.string().min(1),
  targetCommit: z.string().min(1),
  remote: z.string().min(1),
  mergeMethod: z.enum(["merge", "squash", "rebase", "repository-default"]),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["passed", "failed", "blocked"]),
      detail: z.string().min(1),
    }),
  ),
  valid: z.boolean(),
  createdAt: IsoDateTime,
});
export const CleanupStateSchema = z.object({
  status: z.enum(["pending", "completed", "preserved"]),
  ownedResources: z.array(z.string().min(1)).default([]),
  removedResources: z.array(z.string().min(1)).default([]),
  retainedResources: z.array(z.string().min(1)).default([]),
  updatedAt: IsoDateTime,
});
export const TemplateMetadataSchema = z.object({
  schemaVersion: SchemaVersion,
  templateVersion: z.string().min(1),
  files: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
});
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
  modelTier: ModelTierSchema.optional(),
  guidelines: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  contract: PhaseContractSchema.optional(),
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
  budgetTokens: z.number().int().nonnegative().optional(),
  riskOverrides: z.array(z.string().min(1)).default([]),
  allowDirectMerge: z.boolean().optional(),
  deliveryFailureAction: z.enum(["remediate", "escalate", "fail"]).optional(),
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
  model: z.string().min(1).optional(),
  modelTier: ModelTierSchema.optional(),
  guidelines: z.array(Identifier).default([]),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  work: z.array(WorkUnitSchema).default([]),
  checks: z.array(CheckSchema).default([]),
  gate: z
    .object({
      mode: GateModeSchema,
      evaluation: z.enum(["all", "any", "threshold"]).optional(),
      requiredChecks: z.array(Identifier).optional(),
      threshold: z.number().int().positive().optional(),
    })
    .default({ mode: "manual", evaluation: "all" }),
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
  harnessPresentation: z
    .object({
      level: z.enum(["quiet", "normal", "verbose", "protocol"]),
      maxTextLength: z.number().int().positive().max(16_384).default(512),
      maxToolLength: z.number().int().positive().max(16_384).default(240),
    })
    .default({ level: "normal", maxTextLength: 512, maxToolLength: 240 }),
  rawRetention: z
    .object({
      nativeProtocol: z.literal("preview-confirm").default("preview-confirm"),
      preserveNormalized: z.literal(true).default(true),
    })
    .default({ nativeProtocol: "preview-confirm", preserveNormalized: true }),
  budgets: z
    .object({
      invocation: BudgetLimitSchema.optional(),
      phase: BudgetLimitSchema.optional(),
      phases: z.record(Identifier, BudgetLimitSchema).optional(),
      run: BudgetLimitSchema.optional(),
      project: BudgetLimitSchema.optional(),
    })
    .optional(),
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
  policyId: Identifier.optional(),
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
  modelTier: ModelTierSchema.optional(),
  model: z.string().min(1).optional(),
  modelRoute: JsonObject.optional(),
  contractFingerprint: z.string().min(1).optional(),
  promptInputFingerprint: z.string().min(1).optional(),
  status: RunStatusSchema,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
  outputRef: z.string().min(1).optional(),
  cost: z.object({
    amountUsd: z.number().nonnegative().optional(),
    quality: z.enum(["exact", "estimated", "unknown"]),
  }),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
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
  rawOutputAvailable: z.boolean().optional(),
  rawOutputPrunedAt: IsoDateTime.optional(),
  rawOutputUnavailableReason: z.enum(["retention-policy"]).optional(),
  summary: z.string().min(1).max(2_000).optional(),
  consumers: z.array(Identifier).default([]),
  invalidReason: z.string().min(1).optional(),
  modelRoute: ModelRouteSchema.optional(),
  contractFingerprint: z.string().min(1).optional(),
  promptInputFingerprint: z.string().min(1).optional(),
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
  evidenceArtifactIds: z.array(z.string().uuid()).default([]),
  authorization: z
    .object({
      authorizationId: z.string().uuid(),
      delegatedBy: z.object({ type: z.literal("user"), id: z.string().min(1) }),
      scope: z.enum(["gate", "phase", "run", "workflow", "project"]),
      scopeId: z.string().min(1),
      acknowledgedAt: IsoDateTime,
      configurationSource: z.string().min(1),
      expiresAt: IsoDateTime.optional(),
    })
    .optional(),
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
  artifactIds: z.array(z.string().uuid()).default([]),
  handoffId: z.string().uuid().optional(),
  gateDecision: z
    .enum(["satisfied", "rejected", "blocked", "skipped"])
    .optional(),
  changedFiles: z.array(z.string().min(1)).default([]),
  clean: z.boolean().default(true),
});

export const DeliverySchema = z.object({
  schemaVersion: SchemaVersion,
  deliveryId: z.string().uuid(),
  runId: z.string().uuid(),
  provider: z.enum(["github", "local"]),
  mode: z
    .enum(["pull-request", "local-branch", "direct-merge"])
    .default("pull-request"),
  executionStatus: RunStatusSchema,
  status: z.enum([
    "pending",
    "awaiting-merge",
    "auto-merge-requested",
    "checks-failed",
    "rejected",
    "merged",
    "local-branch",
    "failed",
    "closed",
  ]),
  remote: z.string().min(1).default("origin"),
  branch: z.string().min(1),
  targetBranch: z.string().min(1),
  pullRequestNumber: z.number().int().positive().optional(),
  pullRequestUrl: z.string().url().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase", "repository-default"]),
  mergeState: z.string().min(1).optional(),
  autoMergeRequested: z.boolean().default(false),
  hostedChecks: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.string().min(1),
        conclusion: z.string().optional(),
        url: z.string().url().optional(),
      }),
    )
    .default([]),
  reviews: z
    .array(
      z.object({
        actor: z.string().min(1),
        state: z.string().min(1),
        submittedAt: IsoDateTime.optional(),
      }),
    )
    .default([]),
  cleanup: z
    .object({
      branchDeleted: z.boolean(),
      recordedAt: IsoDateTime,
    })
    .optional(),
  failureReason: z.string().min(1).optional(),
  failureAction: z.enum(["remediate", "escalate", "fail"]).optional(),
  preflight: ReleasePreflightSchema.optional(),
  cleanupState: CleanupStateSchema.optional(),
  authorizationId: z.string().uuid().optional(),
  dossierRef: z.string().min(1).optional(),
  resultingCommit: z.string().min(1).optional(),
  updatedAt: IsoDateTime,
});

export const OperatorFailureCategorySchema = z.enum([
  "configuration",
  "dependency",
  "infrastructure",
  "harness",
  "work",
  "check",
  "policy",
  "budget",
  "delivery",
]);

export const OperatorActionTypeSchema = z.enum([
  "run-phase",
  "continue-run",
  "approve",
  "request-changes",
  "reject",
  "reply-to-invocation",
  "retry",
  "resume",
  "inspect-evidence",
  "review-delivery",
  "merge-delivery",
  "configure",
  "reconcile",
]);

export const OperatorActionParametersSchema = z
  .object({
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    changeName: Identifier,
    phaseId: Identifier.optional(),
    gateId: z.string().min(1).optional(),
    invocationId: z.string().uuid().optional(),
    artifactId: z.string().uuid().optional(),
    deliveryId: z.string().uuid().optional(),
    branch: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
  })
  .strict();

export const OperatorActionSchema = z.object({
  actionId: z.string().min(1),
  type: OperatorActionTypeSchema,
  label: z.string().min(1),
  parameters: OperatorActionParametersSchema,
  requiresConfirmation: z.boolean().default(false),
  recommended: z.boolean().default(false),
});

const EvidenceSummarySchema = z.object({
  checks: z.array(
    z.object({
      id: z.string().min(1),
      status: CheckStatusSchema,
      reason: z.string().min(1).optional(),
    }),
  ),
  changedPaths: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  artifactIds: z.array(z.string().uuid()),
});

export const OperatorAttentionTypeSchema = z.enum([
  "manual-approval",
  "configuration-failure",
  "blocked-input",
  "failed-check",
  "budget-block",
  "dependency-failure",
  "infrastructure-failure",
  "harness-failure",
  "work-failure",
  "policy-failure",
  "delivery-failure",
]);

export const OperatorAttentionSchema = z.object({
  attentionId: z.string().min(1),
  type: OperatorAttentionTypeSchema,
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  changeName: Identifier,
  phaseId: Identifier.optional(),
  gateId: z.string().min(1).optional(),
  invocationId: z.string().uuid().optional(),
  title: z.string().min(1),
  reason: z.string().min(1),
  retryable: z.boolean(),
  evidence: EvidenceSummarySchema.optional(),
  actionIds: z.array(z.string().min(1)),
});

export const ClassifiedOperatorErrorSchema = z.object({
  schemaVersion: SchemaVersion,
  code: z.string().min(1),
  category: OperatorFailureCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  runStatus: RunStatusSchema.optional(),
  diagnosticRefs: z.array(z.string().min(1)).default([]),
  recoveryActions: z.array(OperatorActionSchema).default([]),
});

export const OperatorProjectionSchema = z.object({
  schemaVersion: SchemaVersion,
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  changeName: Identifier,
  workflowId: Identifier,
  status: RunStatusSchema,
  summary: z.string().min(1),
  currentPhaseId: Identifier.optional(),
  stoppingPhaseId: Identifier.optional(),
  completedPhaseId: Identifier.optional(),
  nextPhaseId: Identifier.optional(),
  attention: z.array(OperatorAttentionSchema),
  allowedActions: z.array(OperatorActionSchema),
  recommendedActionId: z.string().min(1).optional(),
  evidence: EvidenceSummarySchema,
  delivery: z
    .object({
      deliveryId: z.string().uuid(),
      status: z.string().min(1),
      branch: z.string().min(1),
      targetBranch: z.string().min(1),
      dossierRef: z.string().min(1).optional(),
      checkpointCount: z.number().int().nonnegative(),
    })
    .optional(),
});

export const documents = {
  projectConfig: ProjectConfigSchema,
  modelRouting: ModelRoutingSchema,
  phaseContract: PhaseContractSchema,
  taskAudit: TaskAuditSchema,
  templateMetadata: TemplateMetadataSchema,
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
  modelRoute: ModelRouteSchema,
  releasePreflight: ReleasePreflightSchema,
  cleanupState: CleanupStateSchema,
  reviewFindingResolution: ReviewFindingResolutionSchema,
  operatorProjection: OperatorProjectionSchema,
  operatorAction: OperatorActionSchema,
  operatorAttention: OperatorAttentionSchema,
  classifiedOperatorError: ClassifiedOperatorErrorSchema,
} as const;

export type DocumentName = keyof typeof documents;
export type DocumentValue<T extends DocumentName> = z.infer<
  (typeof documents)[T]
>;

/**
 * JSON Schema export for external consumers, derived from the Zod documents
 * above. Not authoritative: Zod is the sole runtime validation authority, and
 * `unrepresentable: "any"` widens anything JSON Schema cannot express, so these
 * schemas may accept values `parseDocument` rejects. Validate with
 * `parseDocument`, not with these.
 */
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
