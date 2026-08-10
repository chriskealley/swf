import { createHash } from "node:crypto";
import { PhaseContractSchema, type DocumentValue } from "./schemas.js";
import type { ResolvedModelRoute } from "./model-routing.js";

export type PhaseContract = DocumentValue<"phaseContract">;

export interface PromptEvidence {
  ref: string;
  sourceCommit?: string;
  fingerprint?: string;
  summary?: string;
  raw?: boolean;
  valid?: boolean;
}

export interface PromptBuildInput {
  contract: PhaseContract;
  phaseId: string;
  runId: string;
  changeName: string;
  cwd: string;
  guidelines?: string;
  openspecContext?: string;
  evidence?: PromptEvidence[];
  tools?: string[];
  runtimeBoundaries?: string[];
  maxLength?: number;
  modelRoute?: ResolvedModelRoute;
  contractProvenance?: Record<string, string>;
}

export interface BuiltPhasePrompt {
  prompt: string;
  contractFingerprint: string;
  inputFingerprint: string;
  evidenceRefs: string[];
  excludedEvidenceRefs: string[];
}

export interface PhaseExplanation {
  phaseId: string;
  contract: PhaseContract;
  contractFingerprint: string;
  modelRoute?: Record<string, unknown>;
  tools: string[];
  evidenceRefs: string[];
  completionCriteria: string[];
  prohibitedActions: string[];
  provenance: Record<string, string>;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 28))}\n… [bounded by SWF]`;
}

function list(title: string, values: string[]): string {
  return `${title}:\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- none"}`;
}

export function phaseContractFor(id: string): PhaseContract {
  const contracts: Record<string, PhaseContract> = {
    planning: {
      schemaVersion: 1,
      objective: "Produce a valid, scoped OpenSpec implementation plan.",
      responsibilities: [
        "Create proposal, design, specifications, ordered tasks, risks, and planning handoff.",
        "Validate OpenSpec artifacts strictly before completion.",
      ],
      allowedScope: ["openspec/changes/<change>/**", "planning evidence"],
      prohibitedActions: [
        "implement application code",
        "archive",
        "merge",
        "deliver",
      ],
      requiredInputs: ["change description", "repository context"],
      requiredOutputs: [
        "proposal.md",
        "design.md",
        "specs/**/spec.md",
        "tasks.md",
        "planning evidence",
        "handoff",
      ],
      completionCriteria: [
        "all required planning artifacts exist",
        "openspec validate passes",
        "handoff is durable",
      ],
      handoffExpectations: [
        "summarize decisions, risks, and ordered implementation work",
      ],
    },
    building: {
      schemaVersion: 1,
      objective: "Implement approved OpenSpec tasks in dependency order.",
      responsibilities: [
        "Implement code and tests",
        "keep task checkboxes truthful",
        "record deviations and evidence",
      ],
      allowedScope: [
        "approved task implementation paths",
        "tests",
        "task state",
      ],
      prohibitedActions: [
        "archive",
        "merge",
        "deliver",
        "create unapproved authorization",
      ],
      requiredInputs: ["approved plan", "current valid planning evidence"],
      requiredOutputs: [
        "implementation",
        "focused checks",
        "implementation evidence",
        "handoff",
      ],
      completionCriteria: [
        "implemented tasks have evidence",
        "focused checks are run",
        "unimplemented tasks remain unchecked",
      ],
      handoffExpectations: [
        "identify completed tasks, deviations, and remaining blockers",
      ],
    },
    reviewing: {
      schemaVersion: 1,
      objective: "Perform an independent structured code review.",
      responsibilities: [
        "Review correctness, security, regressions, maintainability, and missing tests",
        "record severity and evidence",
      ],
      allowedScope: ["read-only repository and evidence inspection"],
      prohibitedActions: [
        "mutate application code",
        "archive",
        "merge",
        "deliver",
      ],
      requiredInputs: [
        "proposal",
        "design",
        "specifications",
        "tasks",
        "diff",
        "tests",
      ],
      requiredOutputs: [
        "structured review findings",
        "review evidence",
        "handoff",
      ],
      completionCriteria: [
        "all findings have severity and evidence",
        "the inspected commit is recorded",
      ],
      handoffExpectations: [
        "separate actionable defects from optional suggestions",
      ],
    },
    verifying: {
      schemaVersion: 1,
      objective:
        "Audit every OpenSpec task and deterministic verification result.",
      responsibilities: [
        "map every task to implementation and evidence",
        "run required checks",
        "validate specifications strictly",
      ],
      allowedScope: [
        "task audit",
        "verification evidence",
        "authorized remediation only",
      ],
      prohibitedActions: [
        "repeat unconstrained code review",
        "archive",
        "merge",
        "deliver",
        "override failed checks",
      ],
      requiredInputs: [
        "tasks.md",
        "current implementation",
        "review conclusions",
        "declared checks",
      ],
      requiredOutputs: [
        "task audit",
        "deterministic check evidence",
        "verification handoff",
      ],
      completionCriteria: [
        "every applicable task is verified",
        "required checks pass",
        "evidence matches the current commit",
      ],
      handoffExpectations: [
        "identify any task or evidence dependency that blocks release",
      ],
    },
  };
  return PhaseContractSchema.parse(
    contracts[id] ?? {
      schemaVersion: 1,
      objective: `Complete the ${id} phase objective deterministically.`,
      responsibilities: [`Perform the declared ${id} work.`],
      allowedScope: [],
      prohibitedActions: ["archive", "merge", "deliver"],
      requiredInputs: [],
      requiredOutputs: ["phase evidence", "handoff"],
      completionCriteria: ["declared work and required evidence are complete"],
      handoffExpectations: [],
    },
  );
}

export function buildPhasePrompt(input: PromptBuildInput): BuiltPhasePrompt {
  const contract = PhaseContractSchema.parse(input.contract);
  const maxLength = input.maxLength ?? 12_000;
  const usableEvidence = (input.evidence ?? []).filter(
    (entry) => entry.valid !== false && !entry.raw && Boolean(entry.ref),
  );
  const excludedEvidenceRefs = (input.evidence ?? [])
    .filter((entry) => !usableEvidence.includes(entry))
    .map(({ ref }) => ref);
  const evidenceRefs = usableEvidence.map(({ ref }) => ref);
  const sections = [
    `SWF run ${input.runId}, phase ${input.phaseId}, OpenSpec change ${input.changeName}.`,
    `Work only in ${input.cwd}.`,
    `Contract fingerprint: ${fingerprint(contract)}`,
    `Objective:\n${contract.objective}`,
    list("Responsibilities", contract.responsibilities),
    list("Allowed scope", contract.allowedScope),
    list("Prohibited actions", contract.prohibitedActions),
    list("Required inputs", contract.requiredInputs),
    list("Required outputs", contract.requiredOutputs),
    list("Completion criteria", contract.completionCriteria),
    list("Handoff expectations", contract.handoffExpectations),
    `Guidelines:\n${bounded(input.guidelines ?? "none", 2_000)}`,
    `OpenSpec context:\n${bounded(input.openspecContext ?? "none", 2_000)}`,
    `Current valid evidence references:\n${evidenceRefs.length ? evidenceRefs.map((ref) => `- ${ref}`).join("\n") : "- none"}`,
    list("Runtime boundaries", input.runtimeBoundaries ?? []),
    `Available tools: ${(input.tools ?? []).join(", ") || "none"}`,
    input.modelRoute
      ? `Resolved model route:\n${JSON.stringify({
          harness: input.modelRoute.harness,
          modelTier: input.modelRoute.requestedTier,
          model: input.modelRoute.concreteModel,
          source: input.modelRoute.source,
          mappingPath: input.modelRoute.mappingPath,
          fallback: input.modelRoute.fallback,
        })}`
      : "Resolved model route: deterministic/no agent route",
  ];
  const prompt = bounded(sections.join("\n\n"), maxLength);
  return {
    prompt,
    contractFingerprint: fingerprint(contract),
    inputFingerprint: fingerprint({
      phaseId: input.phaseId,
      runId: input.runId,
      changeName: input.changeName,
      cwd: input.cwd,
      guidelines: input.guidelines ?? "",
      openspecContext: input.openspecContext ?? "",
      evidenceRefs,
      runtimeBoundaries: input.runtimeBoundaries ?? [],
      tools: input.tools ?? [],
    }),
    evidenceRefs,
    excludedEvidenceRefs,
  };
}

export function explainPhaseContract(input: {
  phaseId: string;
  contract?: PhaseContract;
  modelRoute?: ResolvedModelRoute;
  tools?: string[];
  evidenceRefs?: string[];
  provenance?: Record<string, string>;
}): PhaseExplanation {
  const contract = PhaseContractSchema.parse(
    input.contract ?? phaseContractFor(input.phaseId),
  );
  return {
    phaseId: input.phaseId,
    contract,
    contractFingerprint: fingerprint(contract),
    modelRoute: input.modelRoute
      ? {
          harness: input.modelRoute.harness,
          modelTier: input.modelRoute.requestedTier,
          model: input.modelRoute.concreteModel,
          source: input.modelRoute.source,
          overriddenSources: input.modelRoute.overriddenSources,
          fallback: input.modelRoute.fallback,
          mappingPath: input.modelRoute.mappingPath,
          fingerprint: input.modelRoute.fingerprint,
        }
      : undefined,
    tools: input.tools ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    completionCriteria: contract.completionCriteria,
    prohibitedActions: contract.prohibitedActions,
    provenance: input.provenance ?? {},
  };
}

export function phaseMutationBoundaryViolations(
  phaseId: string,
  changedFiles: string[],
): string[] {
  if (phaseId === "planning")
    return changedFiles.filter(
      (path) =>
        !path.startsWith("openspec/changes/") && !path.startsWith(".swf/"),
    );
  if (phaseId === "reviewing") return [...changedFiles];
  if (phaseId === "building")
    return changedFiles.filter(
      (path) =>
        path.startsWith("openspec/changes/archive/") ||
        /(^|\/)(merge|delivery|release)\b/i.test(path),
    );
  return [];
}
