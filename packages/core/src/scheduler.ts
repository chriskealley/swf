import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WorkUnitSchema,
  WorkflowSchema,
  type DocumentValue,
} from "./schemas.js";
import { type RunState } from "./domain.js";
import { HerdrClient, type HerdrAgentStatus } from "./herdr.js";
import {
  resolveConfigurationSources,
  type ConfigurationSources,
} from "./project.js";

export type Workflow = DocumentValue<"workflow">;
export type WorkflowPhase = DocumentValue<"workflow">["phases"][number];
export type WorkflowWorkUnit = WorkflowPhase["work"][number];
export type WorkflowCheck = WorkflowPhase["checks"][number];

export interface AdapterCapabilities {
  structuredEvents: boolean;
  modelSelection: boolean;
  toolSelection: boolean;
  cancellation: boolean;
  blockedInput: boolean;
  resume: boolean;
  usage: boolean;
}

export interface AdapterValidation {
  valid: boolean;
  errors: string[];
}

export interface AdapterLaunchRequest {
  runId: string;
  phaseId: string;
  workUnitId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  model?: string;
  tools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
  environment?: Record<string, string>;
}

export interface AdapterInvocation {
  invocationId: string;
  runId: string;
  phaseId: string;
  workUnitId: string;
  paneId: string;
  status:
    "running" | "blocked" | "completed" | "failed" | "cancelled" | "unknown";
  startedAt: string;
  nativeSessionId?: string;
}

export interface AdapterObservation {
  status: AdapterInvocation["status"];
  message?: string;
  blockedPrompt?: string;
  structuredEvents: Array<Record<string, unknown>>;
}

export interface AdapterResult {
  status: Exclude<AdapterInvocation["status"], "running" | "blocked">;
  transcript: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    quality: "exact" | "estimated" | "unknown";
  };
}

export interface HarnessAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  availability(): Promise<AdapterValidation>;
  validate(
    request: Pick<AdapterLaunchRequest, "model" | "tools" | "excludeTools">,
    requiredCapabilities?: string[],
  ): Promise<AdapterValidation>;
  launch(request: AdapterLaunchRequest): Promise<AdapterInvocation>;
  submit(invocation: AdapterInvocation, prompt: string): Promise<void>;
  observe(invocation: AdapterInvocation): Promise<AdapterObservation>;
  cancel(invocation: AdapterInvocation): Promise<void>;
  collect(invocation: AdapterInvocation): Promise<AdapterResult>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    if (this.adapters.has(adapter.id))
      throw new Error(`Harness adapter is already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`No harness adapter is registered for ${id}`);
    return adapter;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function toAdapterStatus(
  status: HerdrAgentStatus,
): AdapterInvocation["status"] {
  if (status === "working") return "running";
  if (status === "blocked") return "blocked";
  if (status === "idle" || status === "done") return "completed";
  return "unknown";
}

function structuredEvents(transcript: string): Array<Record<string, unknown>> {
  return transcript
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractUsage(
  events: Array<Record<string, unknown>>,
): AdapterResult["usage"] {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let costUsd: number | undefined;
  for (const event of events) {
    const message = event.message as Record<string, unknown> | undefined;
    const result = event.result as Record<string, unknown> | undefined;
    const usage = (event.usage ??
      message?.usage ??
      result?.usage ??
      event) as Record<string, unknown>;
    inputTokens =
      numeric(usage.input_tokens ?? usage.inputTokens ?? usage.input) ??
      inputTokens;
    outputTokens =
      numeric(usage.output_tokens ?? usage.outputTokens ?? usage.output) ??
      outputTokens;
    totalTokens =
      numeric(usage.total_tokens ?? usage.totalTokens ?? usage.total) ??
      totalTokens;
    const cost = usage.cost as Record<string, unknown> | number | undefined;
    costUsd =
      numeric(
        usage.cost_usd ??
          usage.costUsd ??
          (typeof cost === "object" ? cost?.total : cost),
      ) ?? costUsd;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      totalTokens ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined),
    costUsd,
    quality:
      totalTokens === undefined &&
      inputTokens === undefined &&
      outputTokens === undefined
        ? "unknown"
        : "exact",
  };
}

export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly capabilities: AdapterCapabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: true,
    resume: false,
    usage: true,
  };

  constructor(readonly herdr: HerdrClient) {}

  async availability(): Promise<AdapterValidation> {
    const diagnostics = await this.herdr.diagnostics(["pi"], ["pi"]);
    return {
      valid: diagnostics.ready,
      errors: [
        ...diagnostics.integrations
          .filter((integration) => !integration.installed)
          .map(
            (integration) =>
              `Herdr integration is missing: ${integration.name}`,
          ),
        ...diagnostics.harnesses
          .filter((harness) => !harness.available)
          .map(
            (harness) => `Harness executable is missing: ${harness.executable}`,
          ),
      ],
    };
  }

  async validate(
    request: Pick<AdapterLaunchRequest, "model" | "tools" | "excludeTools">,
    requiredCapabilities: string[] = [],
  ): Promise<AdapterValidation> {
    const errors: string[] = [];
    for (const capability of requiredCapabilities) {
      const key = capability.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      ) as keyof AdapterCapabilities;
      if (!(key in this.capabilities) || !this.capabilities[key])
        errors.push(`Pi does not advertise required capability: ${capability}`);
    }
    if (
      request.tools?.some((tool) => !tool.trim()) ||
      request.excludeTools?.some((tool) => !tool.trim())
    )
      errors.push("Pi tool selections must be non-empty names");
    return { valid: errors.length === 0, errors };
  }

  private command(request: AdapterLaunchRequest): string {
    // Pi RPC mode provides LF-delimited structured events and accepts prompts
    // through the owned Herdr pane without requiring a separate process.
    const args = ["pi", "--mode", "rpc", "--no-session"];
    if (request.model) args.push("--model", request.model);
    if (request.tools?.length) args.push("--tools", request.tools.join(","));
    if (request.excludeTools?.length)
      args.push("--exclude-tools", request.excludeTools.join(","));
    return args.map(shellQuote).join(" ");
  }

  async launch(request: AdapterLaunchRequest): Promise<AdapterInvocation> {
    const validation = await this.validate(request);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    const observation = await this.herdr.launch({
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      label: `pi-${request.phaseId}-${request.workUnitId}`,
      command: this.command(request),
      timeoutMs: request.timeoutMs,
    });
    const invocation: AdapterInvocation = {
      invocationId: randomUUID(),
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: observation.paneId!,
      status: toAdapterStatus(observation.status),
      startedAt: new Date().toISOString(),
      nativeSessionId: observation.processId,
    };
    await this.submit(invocation, request.prompt);
    return invocation;
  }

  async submit(invocation: AdapterInvocation, prompt: string): Promise<void> {
    await this.herdr.submitPrompt(
      invocation.paneId,
      JSON.stringify({ type: "prompt", message: prompt }),
    );
  }

  async observe(invocation: AdapterInvocation): Promise<AdapterObservation> {
    const observation = await this.herdr.observe(invocation.paneId);
    const transcript = await this.herdr.transcript(invocation.paneId, 200);
    const events = structuredEvents(transcript);
    return {
      status: toAdapterStatus(observation.status),
      message: observation.message,
      blockedPrompt:
        observation.status === "blocked" ? observation.message : undefined,
      structuredEvents: events,
    };
  }

  async cancel(invocation: AdapterInvocation): Promise<void> {
    await this.herdr.submitPrompt(
      invocation.paneId,
      JSON.stringify({ type: "abort" }),
    );
    await this.herdr.cancel(invocation.paneId);
  }

  async collect(invocation: AdapterInvocation): Promise<AdapterResult> {
    const observation = await this.observe(invocation);
    const transcript = await this.herdr.transcript(invocation.paneId, 2_000);
    const status =
      observation.status === "completed"
        ? "completed"
        : observation.status === "cancelled"
          ? "cancelled"
          : "failed";
    return {
      status,
      transcript,
      usage: extractUsage(structuredEvents(transcript)),
    };
  }
}

export interface AdapterConformanceScenario {
  request: AdapterLaunchRequest;
  requiredCapabilities?: string[];
}

export async function assertAdapterConformance(
  adapter: HarnessAdapter,
  scenario: AdapterConformanceScenario,
): Promise<void> {
  const availability = await adapter.availability();
  if (!availability.valid)
    throw new Error(
      `Adapter ${adapter.id} is unavailable: ${availability.errors.join("; ")}`,
    );
  const validation = await adapter.validate(
    scenario.request,
    scenario.requiredCapabilities,
  );
  if (!validation.valid)
    throw new Error(
      `Adapter ${adapter.id} failed validation: ${validation.errors.join("; ")}`,
    );
  const invocation = await adapter.launch(scenario.request);
  await adapter.submit(invocation, "Conformance follow-up");
  await adapter.observe(invocation);
  await adapter.cancel(invocation);
  await adapter.collect(invocation);
}

export interface PhaseEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface PhaseEligibilityContext {
  state: RunState;
  activePhaseId?: string;
  worktreeAtCheckpoint: boolean;
  artifactsValid: boolean;
  entryChecksPass: boolean;
  policyAllows: boolean;
  budgetAvailable: boolean;
  adapter?: HarnessAdapter;
  requiredCapabilities?: string[];
}

function phaseIndex(workflow: Workflow, phaseId: string): number {
  return workflow.phases.findIndex((phase) => phase.id === phaseId);
}

export function evaluatePhaseEligibility(
  workflow: Workflow,
  phaseId: string,
  context: PhaseEligibilityContext,
): PhaseEligibility {
  const phase = workflow.phases.find((candidate) => candidate.id === phaseId);
  if (!phase)
    return { eligible: false, reasons: [`Unknown phase: ${phaseId}`] };
  const reasons: string[] = [];
  const index = phaseIndex(workflow, phaseId);
  const current = context.state.phases[phaseId];
  if (current?.status === "completed")
    reasons.push(
      `Phase ${phaseId} is already completed; use an explicit rerun`,
    );
  for (const predecessor of workflow.phases.slice(0, index)) {
    if (context.state.phases[predecessor.id]?.status !== "completed")
      reasons.push(`Predecessor ${predecessor.id} is not completed`);
  }
  if (context.activePhaseId && context.activePhaseId !== phaseId)
    reasons.push(`Conflicting phase is active: ${context.activePhaseId}`);
  if (!context.worktreeAtCheckpoint)
    reasons.push("Run worktree does not match its checkpoint");
  if (!context.artifactsValid)
    reasons.push("Required artifacts are missing, stale, or invalid");
  if (!context.entryChecksPass)
    reasons.push("Phase entry checks have not passed");
  if (!context.policyAllows)
    reasons.push("Resolved policy does not permit execution");
  if (!context.budgetAvailable) reasons.push("Resolved budget is exhausted");
  if (context.adapter) {
    for (const capability of context.requiredCapabilities ??
      phase.requiredCapabilities) {
      const key = capability.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      ) as keyof AdapterCapabilities;
      if (
        !(key in context.adapter.capabilities) ||
        !context.adapter.capabilities[key]
      )
        reasons.push(
          `Harness ${context.adapter.id} lacks required capability: ${capability}`,
        );
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

export interface ResolvedPhaseExecution {
  harness?: string;
  model?: string;
  profile: string;
  guidelines: string[];
  timeoutMs?: number;
  retryLimit?: number;
  budgetUsd?: number;
  artifactContext: string[];
  configuration: Record<string, unknown>;
}

export interface WorkExecutor {
  execute(
    unit: WorkflowWorkUnit,
    context: { phase: WorkflowPhase; resolved: Record<string, unknown> },
  ): Promise<{ status: "completed" | "blocked" | "failed"; output?: string }>;
}

export interface PhaseExecutionResult {
  phaseId: string;
  status: "completed" | "blocked" | "failed";
  work: Array<{
    workUnitId: string;
    status: "completed" | "blocked" | "failed";
    output?: string;
  }>;
  resolved: Record<string, unknown>;
}

function sequentialSteps(unit: WorkflowWorkUnit): WorkflowWorkUnit[] {
  if (unit.type !== "sequential") return [unit];
  const steps = unit.options.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => WorkUnitSchema.parse(step));
}

export class WorkflowScheduler {
  constructor(
    readonly workflow: Workflow,
    readonly executors: WorkExecutor,
  ) {
    WorkflowSchema.parse(workflow);
  }

  resolvePhaseConfiguration(
    phase: WorkflowPhase,
    sources: ConfigurationSources = {},
  ): Record<string, unknown> {
    return resolveConfigurationSources({
      ...sources,
      phase: { ...(sources.phase ?? {}), ...phase },
    }).value;
  }

  resolvePhaseExecution(
    phase: WorkflowPhase,
    sources: ConfigurationSources = {},
  ): ResolvedPhaseExecution {
    const configuration = this.resolvePhaseConfiguration(phase, sources);
    return {
      harness:
        typeof configuration.harness === "string"
          ? configuration.harness
          : undefined,
      model:
        typeof configuration.model === "string"
          ? configuration.model
          : undefined,
      profile: phase.profile,
      guidelines: phase.guidelines,
      timeoutMs:
        typeof configuration.timeoutMs === "number"
          ? configuration.timeoutMs
          : undefined,
      retryLimit:
        typeof configuration.retryLimit === "number"
          ? configuration.retryLimit
          : undefined,
      budgetUsd:
        typeof configuration.budgetUsd === "number"
          ? configuration.budgetUsd
          : undefined,
      artifactContext: Array.isArray(configuration.artifactContext)
        ? configuration.artifactContext.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      configuration,
    };
  }

  async executePhase(
    phaseId: string,
    eligibility: PhaseEligibility,
    sources: ConfigurationSources = {},
  ): Promise<PhaseExecutionResult> {
    if (!eligibility.eligible)
      throw new Error(
        `Phase ${phaseId} is ineligible: ${eligibility.reasons.join("; ")}`,
      );
    const phase = this.workflow.phases.find(
      (candidate) => candidate.id === phaseId,
    );
    if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
    const resolved = this.resolvePhaseConfiguration(phase, sources);
    const work: PhaseExecutionResult["work"] = [];
    for (const declaredUnit of phase.work) {
      const steps = sequentialSteps(declaredUnit);
      if (declaredUnit.type === "sequential" && steps.length === 0) {
        work.push({ workUnitId: declaredUnit.id, status: "completed" });
        continue;
      }
      for (const unit of steps) {
        const result = await this.executors.execute(unit, { phase, resolved });
        work.push({ workUnitId: unit.id, ...result });
        if (result.status !== "completed")
          return { phaseId, status: result.status, work, resolved };
      }
    }
    return { phaseId, status: "completed", work, resolved };
  }
}

export interface BlockedAgentInput {
  invocationId: string;
  runId: string;
  phaseId: string;
  prompt: string;
}

export class BlockedAgentRouter {
  private readonly blocked = new Map<
    string,
    {
      adapter: HarnessAdapter;
      invocation: AdapterInvocation;
      input: BlockedAgentInput;
    }
  >();

  report(
    adapter: HarnessAdapter,
    invocation: AdapterInvocation,
    observation: AdapterObservation,
  ): BlockedAgentInput | undefined {
    if (observation.status !== "blocked") return undefined;
    const input = {
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      phaseId: invocation.phaseId,
      prompt: observation.blockedPrompt ?? "Agent requires operator input",
    };
    this.blocked.set(invocation.invocationId, { adapter, invocation, input });
    return input;
  }

  list(): BlockedAgentInput[] {
    return [...this.blocked.values()].map((entry) => entry.input);
  }

  async submit(invocationId: string, response: string): Promise<void> {
    const entry = this.blocked.get(invocationId);
    if (!entry)
      throw new Error(`No blocked invocation is registered: ${invocationId}`);
    await entry.adapter.submit(entry.invocation, response);
    this.blocked.delete(invocationId);
  }
}

export interface ExplorationBrief {
  explorationId: string;
  problem: string;
  goals: string[];
  nonGoals: string[];
  options: string[];
  decisions: string[];
  openQuestions: string[];
  codebaseFindings: string[];
  candidateScope: string;
  candidateChangeName: string;
}

export type PlanningInput =
  | { kind: "description"; description: string }
  | { kind: "exploration"; brief: ExplorationBrief };

export function normalizePlanningInput(input: {
  description?: string;
  exploration?: ExplorationBrief;
}): PlanningInput {
  if (input.description?.trim())
    return { kind: "description", description: input.description.trim() };
  if (input.exploration)
    return { kind: "exploration", brief: input.exploration };
  throw new Error(
    "Planning requires a non-empty description or an explicitly selected exploration brief",
  );
}

export interface PlanningArtifacts {
  proposal: string;
  design: string;
  specification: string;
  tasks: string;
  evidence: string;
  handoff: string;
}

export async function produceDefaultPlanningArtifacts(input: {
  changeRoot: string;
  changeName: string;
  planning: PlanningInput;
}): Promise<PlanningArtifacts> {
  const description =
    input.planning.kind === "description"
      ? input.planning.description
      : input.planning.brief.problem;
  const proposal = join(input.changeRoot, "proposal.md");
  const design = join(input.changeRoot, "design.md");
  const specification = join(
    input.changeRoot,
    "specs",
    input.changeName,
    "spec.md",
  );
  const tasks = join(input.changeRoot, "tasks.md");
  const evidence = join(input.changeRoot, "evidence", "planning.json");
  const handoff = join(input.changeRoot, "evidence", "planning-handoff.json");
  await mkdir(dirname(specification), { recursive: true });
  await mkdir(dirname(evidence), { recursive: true });
  await Promise.all([
    writeFile(
      proposal,
      `## Why\n\n${description}\n\n## What Changes\n\n- Implement ${input.changeName}.\n`,
      "utf8",
    ),
    writeFile(
      design,
      `## Context\n\n${description}\n\n## Decisions\n\n- Planning established the initial implementation boundary.\n`,
      "utf8",
    ),
    writeFile(
      specification,
      `## ADDED Requirements\n\n### Requirement: ${input.changeName}\nThe system SHALL implement the planned behavior.\n\n#### Scenario: Planned behavior\n- **WHEN** the change is executed\n- **THEN** the requested behavior is available\n`,
      "utf8",
    ),
    writeFile(
      tasks,
      `## Implementation\n\n- [ ] Implement ${input.changeName}\n`,
      "utf8",
    ),
    writeFile(
      evidence,
      `${JSON.stringify({ schemaVersion: 1, phase: "planning", input: input.planning }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      handoff,
      `${JSON.stringify({ schemaVersion: 1, phase: "planning", summary: [description], decisions: [], knownIssues: [], recommendedNextActions: ["Implement the planned tasks"] }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return { proposal, design, specification, tasks, evidence, handoff };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validatePlanningArtifacts(
  changeRoot: string,
): Promise<string[]> {
  const required = [
    "proposal.md",
    "design.md",
    "tasks.md",
    "evidence/planning.json",
    "evidence/planning-handoff.json",
  ];
  const errors = (
    await Promise.all(
      required.map(async (file) =>
        (await exists(join(changeRoot, file))) ? undefined : `Missing ${file}`,
      ),
    )
  ).filter((error): error is string => error !== undefined);
  try {
    const capabilities = await readdir(join(changeRoot, "specs"));
    if (capabilities.length === 0)
      errors.push("Planning must create at least one capability specification");
    else if (
      !(
        await Promise.all(
          capabilities.map((capability) =>
            exists(join(changeRoot, "specs", capability, "spec.md")),
          ),
        )
      ).some(Boolean)
    ) {
      errors.push("Planning capability specifications must be named spec.md");
    }
  } catch {
    errors.push("Missing specs directory");
  }
  return errors;
}

export interface RerunPreview {
  phaseId: string;
  invalidatedPhaseIds: string[];
  invalidatedArtifactIds: string[];
  invalidatedCheckpointIds: string[];
  invalidatesDelivery: boolean;
}

export function previewPhaseRerun(
  workflow: Workflow,
  state: RunState,
  phaseId: string,
): RerunPreview {
  const index = phaseIndex(workflow, phaseId);
  if (index < 0) throw new Error(`Unknown phase: ${phaseId}`);
  if (state.phases[phaseId]?.status !== "completed")
    throw new Error(
      `Only completed phases can be explicitly rerun: ${phaseId}`,
    );
  const affected = workflow.phases.slice(index).map((phase) => phase.id);
  return {
    phaseId,
    invalidatedPhaseIds: affected,
    invalidatedArtifactIds: Object.values(state.artifacts)
      .filter((artifact) => affected.includes(artifact.phaseId))
      .map((artifact) => artifact.artifactId),
    invalidatedCheckpointIds: Object.values(state.checkpoints)
      .filter((checkpoint) => affected.includes(checkpoint.phaseId))
      .map((checkpoint) => checkpoint.checkpointId),
    invalidatesDelivery: Object.keys(state.deliveries).length > 0,
  };
}

export function authorizePhaseRerun(
  preview: RerunPreview,
  authorized: boolean,
): RerunPreview {
  if (!authorized)
    throw new Error(
      `Rerun of ${preview.phaseId} requires explicit authorization`,
    );
  return preview;
}

export function applyRerunInvalidation(
  state: RunState,
  preview: RerunPreview,
): RunState {
  const phases = Object.fromEntries(
    Object.entries(state.phases).map(([id, phase]) => [
      id,
      preview.invalidatedPhaseIds.includes(id)
        ? {
            ...phase,
            status: "pending" as const,
            updatedAt: new Date().toISOString(),
          }
        : { ...phase },
    ]),
  );
  const artifacts = Object.fromEntries(
    Object.entries(state.artifacts).map(([id, artifact]) => [
      id,
      preview.invalidatedArtifactIds.includes(id)
        ? { ...artifact, status: "invalid" as const }
        : { ...artifact },
    ]),
  );
  const deliveries = preview.invalidatesDelivery
    ? Object.fromEntries(
        Object.entries(state.deliveries).map(([id, delivery]) => [
          id,
          { ...delivery, status: "pending" as const },
        ]),
      )
    : { ...state.deliveries };
  return { ...state, phases, artifacts, deliveries };
}

export function assertMutatingOrchestrationAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.SWF_CHILD_MODE === "1" &&
    environment.SWF_ALLOW_NESTED_ORCHESTRATION !== "1"
  ) {
    throw new Error(
      "Child phase invocations cannot mutate SWF orchestration without explicit nested-execution permission",
    );
  }
}

export function childInvocationEnvironment(input: {
  runId: string;
  phaseId: string;
  invocationId: string;
  allowNested?: boolean;
}): Record<string, string> {
  return {
    SWF_RUN_ID: input.runId,
    SWF_PHASE_ID: input.phaseId,
    SWF_INVOCATION_ID: input.invocationId,
    SWF_CHILD_MODE: "1",
    SWF_ALLOW_NESTED_ORCHESTRATION: input.allowNested ? "1" : "0",
  };
}
