import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  AdapterRegistry,
  ArtifactStore,
  AuditLog,
  BlockedAgentRouter,
  CheckpointManager,
  GitClient,
  GitCommandError,
  HarnessWorkExecutor,
  HerdrClient,
  NodeCommandRunner,
  PiHarnessAdapter,
  Redactor,
  RunRuntime,
  RuntimeOwnershipStore,
  WorkflowScheduler,
  StateMigrationManager,
  DeliveryOrchestrator,
  DeliveryPreflightError,
  ExplorationStore,
  RunEventStore,
  assertBudgetsAvailable,
  assertChecksAdopted,
  assertLoopbackHttpEndpoint,
  auditOpenSpecTasks,
  buildOperatorProjection,
  buildPhasePrompt,
  classifyOperatorError,
  phaseContractFor,
  createRunEvent,
  enforcePrivatePermissions,
  evaluateBudgets,
  evaluateGate,
  evaluatePhaseEligibility,
  exportRun,
  findProjectRoot,
  importRun,
  humanApprovalEvidence,
  inspectOperationalHealth,
  isProjectTrusted,
  loadProjectDeliverySettings,
  loadProjectExecutionSettings,
  defaultTemplateFiles,
  readProjectConfig,
  reduceRunState,
  persistChangeDossier,
  previewPhaseRerun,
  requestStructuredHandoff,
  recordAgentReview,
  recordTaskAudit,
  recordAutoApproval,
  recordHumanApproval,
  resolveApprovalMode,
  resolveDeliveryPlan,
  modelRouteExplanation,
  resolveModelRoute,
  validateModelRouteCapabilities,
  diagnoseModelRoutes,
  previewModelMapping,
  applyModelMapping,
  explainPhaseContract,
  phaseMutationBoundaryViolations,
  releasePreflight,
  releasePreflightFingerprint,
  summarizeReleaseApproval,
  discoverProjectChecks,
  previewCheckAdoption,
  applyCheckAdoption,
  readTemplateMetadata,
  inspectTemplateDiff,
  adoptTemplateFiles,
  retainDeliveryUpdate,
  runCommandCheck,
  runOpenSpecCheck,
  validatePlanningArtifacts,
  validateProjectConfiguration,
  type AdapterInvocation,
  type AdapterObservation,
  type ApprovalAuthorization,
  type BudgetConfiguration,
  type BudgetUsage,
  type CheckEvidence,
  type CommandRunner,
  type DeliveryRequest,
  type DeliveryUpdate,
  type EventDraft,
  type EventType,
  type HarnessAdapter,
  type HostingAdapter,
  type ClassifiedOperatorError,
  type OperatorProjection,
  type RedactionOptions,
  type Run,
  type RunState,
} from "@swf/core";
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CopilotHarnessAdapter,
  GitHubAdapter,
} from "@swf/integrations";

const SERVICE_SCHEMA_VERSION = 1;

export interface ServiceMetadata {
  schemaVersion: 1;
  serviceId: string;
  pid: number;
  endpoint: string;
  credential: string;
  startedAt: string;
}

export class ServiceAlreadyRunningError extends Error {
  constructor(readonly metadata?: ServiceMetadata) {
    super(
      metadata
        ? `SWF service is already running at ${metadata.endpoint}`
        : "SWF service is already running",
    );
    this.name = "ServiceAlreadyRunningError";
  }
}

export class ServiceAuthenticationError extends Error {
  constructor() {
    super("SWF service credentials are required");
    this.name = "ServiceAuthenticationError";
  }
}

export class OperatorCommandError extends Error {
  constructor(
    readonly classified: ClassifiedOperatorError,
    readonly projection?: OperatorProjection,
  ) {
    super(classified.message);
    this.name = "OperatorCommandError";
  }
}

export type ProjectAvailability =
  "available" | "unavailable" | "permission-denied";

export interface RegisteredProject {
  projectId: string;
  displayName: string;
  root: string;
  stateDirectory: string;
  lastSeenAt: string;
  availability: ProjectAvailability;
  unavailableReason?: string;
  previousRoots: string[];
}

interface ProjectRegistryFile {
  schemaVersion: 1;
  projects: RegisteredProject[];
}

export interface ServiceEvent {
  id: number;
  timestamp: string;
  type: string;
  projectId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

export interface ServiceSubscription extends AsyncIterable<ServiceEvent> {
  close(): void;
}

class EventBroker {
  private nextId = 1;

  constructor(readonly redactor: Redactor) {}
  private readonly retained: ServiceEvent[] = [];
  private readonly subscribers = new Set<AsyncEventSubscription>();

  publish(event: Omit<ServiceEvent, "id" | "timestamp">): ServiceEvent {
    const published = this.redactor.value<ServiceEvent>({
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      ...event,
    });
    this.retained.push(published);
    if (this.retained.length > 1_000) this.retained.shift();
    for (const subscriber of this.subscribers) subscriber.push(published);
    return published;
  }

  subscribe(after = 0): ServiceSubscription {
    const subscription = new AsyncEventSubscription(
      this.retained.filter((event) => event.id > after),
      () => this.subscribers.delete(subscription),
    );
    this.subscribers.add(subscription);
    return subscription;
  }
}

class AsyncEventSubscription
  implements ServiceSubscription, AsyncIterator<ServiceEvent>
{
  private readonly queued: ServiceEvent[];
  private resolver?: (result: IteratorResult<ServiceEvent>) => void;
  private closed = false;

  constructor(
    initial: ServiceEvent[],
    private readonly onClose: () => void,
  ) {
    this.queued = [...initial];
  }

  push(event: ServiceEvent): void {
    if (this.closed) return;
    const next = this.resolver;
    this.resolver = undefined;
    if (next) next({ done: false, value: event });
    else this.queued.push(event);
  }

  next(): Promise<IteratorResult<ServiceEvent>> {
    const event = this.queued.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  return(): Promise<IteratorResult<ServiceEvent>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ServiceEvent> {
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const resolver = this.resolver;
    this.resolver = undefined;
    resolver?.({ done: true, value: undefined });
    this.onClose();
  }
}

function defaultServiceHome(): string {
  return (
    process.env.SWF_SERVICE_HOME ??
    process.env.SWF_CONFIG_HOME ??
    join(process.env.HOME ?? process.cwd(), ".config", "swf")
  );
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function credentialsMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export class ProjectRegistry {
  constructor(readonly serviceHome: string) {}

  private get path(): string {
    return join(this.serviceHome, "projects.json");
  }

  private async read(): Promise<ProjectRegistryFile> {
    const registry = await readJson<ProjectRegistryFile>(this.path);
    if (!registry)
      return { schemaVersion: SERVICE_SCHEMA_VERSION, projects: [] };
    if (
      registry.schemaVersion !== SERVICE_SCHEMA_VERSION ||
      !Array.isArray(registry.projects)
    ) {
      throw new Error(`Unsupported project registry at ${this.path}`);
    }
    return registry;
  }

  private async write(registry: ProjectRegistryFile): Promise<void> {
    await writeAtomically(this.path, `${JSON.stringify(registry, null, 2)}\n`);
  }

  async list(): Promise<RegisteredProject[]> {
    return (await this.read()).projects;
  }

  async register(input: {
    projectId: string;
    displayName: string;
    root: string;
  }): Promise<RegisteredProject> {
    const registry = await this.read();
    let canonicalRoot = input.root;
    let availability: ProjectAvailability = "available";
    let unavailableReason: string | undefined;
    try {
      canonicalRoot = await realpath(input.root);
    } catch (error) {
      availability = isPermissionError(error)
        ? "permission-denied"
        : "unavailable";
      unavailableReason =
        error instanceof Error
          ? error.message
          : "project path cannot be accessed";
    }
    const now = new Date().toISOString();
    const existing = registry.projects.find(
      (project) => project.projectId === input.projectId,
    );
    const project: RegisteredProject = {
      projectId: input.projectId,
      displayName: input.displayName,
      root: canonicalRoot,
      stateDirectory: join(canonicalRoot, ".swf-state"),
      lastSeenAt: now,
      availability,
      unavailableReason,
      previousRoots:
        existing && existing.root !== canonicalRoot
          ? [...new Set([...existing.previousRoots, existing.root])]
          : (existing?.previousRoots ?? []),
    };
    if (existing)
      registry.projects[registry.projects.indexOf(existing)] = project;
    else registry.projects.push(project);
    await this.write(registry);
    return project;
  }

  async reconcile(): Promise<RegisteredProject[]> {
    const registry = await this.read();
    const reconciled = await Promise.all(
      registry.projects.map(async (project) => {
        try {
          const canonicalRoot = await realpath(project.root);
          await stat(canonicalRoot);
          return {
            ...project,
            root: canonicalRoot,
            stateDirectory: join(canonicalRoot, ".swf-state"),
            availability: "available" as const,
            unavailableReason: undefined,
          };
        } catch (error) {
          return {
            ...project,
            availability: isPermissionError(error)
              ? ("permission-denied" as const)
              : ("unavailable" as const),
            unavailableReason:
              error instanceof Error
                ? error.message
                : "project path cannot be accessed",
          };
        }
      }),
    );
    registry.projects = reconciled;
    await this.write(registry);
    return reconciled;
  }
}

export interface WorkRegistration {
  runId: string;
  projectId: string;
  safeBoundary: Promise<void>;
  interrupt: () => Promise<void>;
}

export interface RecoveryAction {
  action: "resume" | "pause" | "complete" | "block";
  reason?: string;
}

export type RecoveryReconciler = (
  project: RegisteredProject,
  state: RunState,
) => Promise<RecoveryAction>;

export interface ServiceOptions {
  serviceHome?: string;
  endpoint?: string;
  hostingAdapter?: HostingAdapter;
  deliveryPollIntervalMs?: number;
  harnessAdapters?: HarnessAdapter[];
  redaction?: RedactionOptions;
  serviceBudget?: BudgetConfiguration["service"];
  projectTrust?: (root: string) => Promise<boolean>;
  stuckAfterMs?: number;
  herdrClient?: HerdrClient;
  commandRunner?: CommandRunner;
  adoptSameProcessLock?: boolean;
}

export interface ServiceQuery {
  resource:
    | "overview"
    | "adapters"
    | "projects"
    | "runs"
    | "run"
    | "phases"
    | "invocations"
    | "artifacts"
    | "approvals"
    | "costs"
    | "configuration"
    | "delivery"
    | "output"
    | "budgets"
    | "operations"
    | "blocked-inputs"
    | "explorations"
    | "exploration"
    | "model-routes"
    | "phase-explanation"
    | "operator-projection"
    | "check-discovery"
    | "defaults";
  projectId?: string;
  runId?: string;
  ref?: string;
  raw?: boolean;
  phaseId?: string;
}

export interface PruningCriteria {
  ageDays?: number;
  runId?: string;
  budgetBytes?: number;
}

export interface PruningPreview {
  schemaVersion: 1;
  confirmationId: string;
  criteria: PruningCriteria;
  candidates: Array<{
    runId: string;
    ref: string;
    bytes: number;
    modifiedAt: string;
  }>;
  totalBytes: number;
  expiresAt: string;
}

interface PendingPruning extends PruningPreview {
  projectId: string;
  paths: string[];
}

export type ServiceCommand = (
  | {
      type: "new" | "run" | "next" | "phase-run";
      projectId: string;
      changeName: string;
      phaseId?: string;
      description?: string;
      workflowId?: string;
      policyId?: string;
      fromExplorationId?: string;
      authorization?: ApprovalAuthorization;
    }
  | {
      type: "phase-rerun" | "phase-skip" | "check-run";
      projectId: string;
      changeName: string;
      phaseId?: string;
      checkId?: string;
      authorized?: boolean;
    }
  | {
      type: "explore-start";
      projectId: string;
      idea: string;
      candidateChangeName?: string;
    }
  | {
      type:
        | "explore-resume"
        | "explore-cancel"
        | "explore-discard"
        | "explore-promote"
        | "explore-answer";
      projectId: string;
      explorationId: string;
      answer?: string;
    }
  | {
      type: "start" | "pause" | "resume" | "cancel";
      projectId: string;
      runId: string;
      phaseId?: string;
    }
  | {
      type: "approve" | "reject" | "request-changes";
      projectId: string;
      runId: string;
      phaseId: string;
      gateId: string;
      reason?: string;
      actorId: string;
      evidenceArtifactIds?: string[];
    }
  | {
      type: "remediate";
      projectId: string;
      runId: string;
      phaseId: string;
      reason?: string;
    }
  | {
      type: "rollback";
      projectId: string;
      runId: string;
      phaseId: string;
      checkpointId: string;
      invalidatedPhaseIds?: string[];
      invalidatedArtifactIds?: string[];
      authorized?: boolean;
    }
  | {
      type: "blocked-input";
      invocationId: string;
      response: string;
      projectId?: string;
      runId?: string;
    }
  | {
      type: "deliver" | "refresh-delivery";
      projectId: string;
      runId: string;
    }
  | {
      type: "archive-change";
      projectId: string;
      runId: string;
      authorized?: boolean;
    }
  | {
      type:
        | "model-map-preview"
        | "model-map-apply"
        | "checks-preview"
        | "checks-apply"
        | "defaults-adopt";
      projectId: string;
      tier?: string;
      harness?: string;
      model?: string;
      selectedIds?: string[];
      confirmed?: boolean;
      selectedPaths?: string[];
    }
  | {
      type: "reconcile";
      projectId: string;
      apply?: boolean;
      staleAfterMs?: number;
    }
  | {
      type: "migrate";
      projectId: string;
      target?: number;
      dryRun?: boolean;
      rollbackBackupId?: string;
    }
  | {
      type: "export-run";
      projectId: string;
      runId: string;
      path: string;
    }
  | {
      type: "import-run";
      projectId: string;
      path: string;
    }
) & {
  childContext?: {
    childMode: boolean;
    allowNested: boolean;
    runId?: string;
    phaseId?: string;
    invocationId?: string;
  };
};

export class SwfService {
  readonly serviceHome: string;
  readonly endpoint: string;
  readonly registry: ProjectRegistry;
  private readonly broker: EventBroker;
  private readonly redactor: Redactor;
  private readonly audit: AuditLog;
  private readonly blockedAgents = new BlockedAgentRouter();
  private readonly activeWork = new Map<string, WorkRegistration>();
  private readonly pendingPruning = new Map<string, PendingPruning>();
  private readonly deliveryMonitors = new Map<string, AbortController>();
  private readonly hostingAdapter: HostingAdapter;
  private readonly harnessAdapters: HarnessAdapter[];
  private readonly herdr: HerdrClient;
  private readonly commandRunner: CommandRunner;
  private readonly deliveryPollIntervalMs: number;
  private readonly serviceBudget?: BudgetConfiguration["service"];
  private readonly projectTrust: (root: string) => Promise<boolean>;
  private readonly stuckAfterMs: number;
  private readonly adoptSameProcessLock: boolean;
  private lock?: Awaited<ReturnType<typeof open>>;
  private metadata?: ServiceMetadata;
  private acceptingWork = false;

  constructor(options: ServiceOptions = {}) {
    this.serviceHome = options.serviceHome ?? defaultServiceHome();
    const host = process.env.NITRO_HOST ?? "127.0.0.1";
    const port = process.env.NITRO_PORT ?? process.env.PORT ?? "34671";
    this.endpoint =
      options.endpoint ??
      process.env.SWF_SERVICE_ENDPOINT ??
      `http://${host}:${port}`;
    assertLoopbackHttpEndpoint(this.endpoint);
    this.redactor = new Redactor(options.redaction);
    this.broker = new EventBroker(this.redactor);
    this.audit = new AuditLog(
      join(this.serviceHome, "audit.jsonl"),
      this.redactor,
    );
    this.registry = new ProjectRegistry(this.serviceHome);
    this.hostingAdapter = options.hostingAdapter ?? new GitHubAdapter();
    this.herdr = options.herdrClient ?? new HerdrClient();
    this.commandRunner = options.commandRunner ?? new NodeCommandRunner();
    this.harnessAdapters = options.harnessAdapters ?? [
      new PiHarnessAdapter(this.herdr),
      new CodexHarnessAdapter(this.herdr),
      new ClaudeHarnessAdapter(this.herdr),
      new CopilotHarnessAdapter(this.herdr),
    ];
    this.deliveryPollIntervalMs = options.deliveryPollIntervalMs ?? 30_000;
    this.serviceBudget = options.serviceBudget;
    this.projectTrust =
      options.projectTrust ??
      ((root) => isProjectTrusted(root, { configHome: this.serviceHome }));
    this.stuckAfterMs = options.stuckAfterMs ?? 30 * 60_000;
    this.adoptSameProcessLock = options.adoptSameProcessLock ?? false;
  }

  private get lockPath(): string {
    return join(this.serviceHome, "service.lock");
  }

  private get metadataPath(): string {
    return join(this.serviceHome, "service.json");
  }

  async start(): Promise<ServiceMetadata> {
    if (this.metadata) return this.metadata;
    await enforcePrivatePermissions({ directories: [this.serviceHome] });
    try {
      this.lock = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJson<ServiceMetadata>(this.metadataPath);
      if (
        this.adoptSameProcessLock &&
        existing?.pid === process.pid &&
        existing.endpoint === this.endpoint
      ) {
        this.lock = await open(this.lockPath, "r+");
        this.metadata = existing;
        this.acceptingWork = true;
        this.broker.publish({
          type: "service.reloaded",
          data: {
            serviceId: existing.serviceId,
            endpoint: existing.endpoint,
          },
        });
        await this.audit.append({
          operation: "service.reload-adopt",
          actor: { type: "service", id: existing.serviceId },
          outcome: "completed",
          details: { endpoint: existing.endpoint, pid: existing.pid },
        });
        await this.recover();
        return existing;
      }
      throw new ServiceAlreadyRunningError(existing);
    }
    const metadata: ServiceMetadata = {
      schemaVersion: SERVICE_SCHEMA_VERSION,
      serviceId: randomUUID(),
      pid: process.pid,
      endpoint: this.endpoint,
      credential: randomBytes(32).toString("base64url"),
      startedAt: new Date().toISOString(),
    };
    try {
      await this.lock.writeFile(`${JSON.stringify(metadata)}\n`);
      await this.lock.sync();
      await writeAtomically(
        this.metadataPath,
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      await enforcePrivatePermissions({
        directories: [this.serviceHome],
        files: [this.lockPath, this.metadataPath],
      });
      this.metadata = metadata;
      this.acceptingWork = true;
      this.broker.publish({
        type: "service.started",
        data: { serviceId: metadata.serviceId, endpoint: metadata.endpoint },
      });
      await this.audit.append({
        operation: "service.start",
        actor: { type: "service", id: metadata.serviceId },
        outcome: "completed",
        details: { endpoint: metadata.endpoint, pid: metadata.pid },
      });
      await this.recover();
      return metadata;
    } catch (error) {
      await this.lock.close();
      this.lock = undefined;
      await rm(this.lockPath, { force: true });
      throw error;
    }
  }

  get status(): "stopped" | "running" | "draining" {
    if (!this.metadata) return "stopped";
    return this.acceptingWork ? "running" : "draining";
  }

  get serviceMetadata(): ServiceMetadata | undefined {
    return this.metadata;
  }

  authenticate(credential: string | undefined): void {
    if (
      !this.metadata ||
      !credential ||
      !credentialsMatch(this.metadata.credential, credential)
    )
      throw new ServiceAuthenticationError();
  }

  subscribe(lastEventId = 0): ServiceSubscription {
    return this.broker.subscribe(lastEventId);
  }

  reportBlockedAgent(
    adapter: HarnessAdapter,
    invocation: AdapterInvocation,
    observation: AdapterObservation,
  ): void {
    const input = this.blockedAgents.report(adapter, invocation, observation);
    if (input) {
      this.broker.publish({
        type: "agent.blocked",
        projectId: undefined,
        runId: invocation.runId,
        data: { ...input },
      });
    }
  }

  blockedInputs() {
    return this.blockedAgents.list();
  }

  async submitBlockedInput(
    invocationId: string,
    response: string,
  ): Promise<void> {
    await this.blockedAgents.submit(invocationId, response);
    this.broker.publish({
      type: "agent.input-submitted",
      data: { invocationId },
    });
  }

  async registerProject(input: {
    projectId: string;
    displayName: string;
    root: string;
  }): Promise<RegisteredProject> {
    this.requireRunning();
    if (!(await this.projectTrust(input.root))) {
      await this.audit.append({
        operation: "project.register",
        actor: { type: "user", id: "operator" },
        projectId: input.projectId,
        outcome: "rejected",
        details: { root: input.root, reason: "project is not trusted" },
      });
      throw new Error(
        `Project is not trusted: ${input.root}. Run swf init --trust first.`,
      );
    }
    const project = await this.registry.register(input);
    await enforcePrivatePermissions({
      directories: [project.stateDirectory],
    });
    await this.audit.append({
      operation: "project.register",
      actor: { type: "user", id: "operator" },
      projectId: project.projectId,
      outcome: "completed",
      details: { root: project.root, availability: project.availability },
    });
    this.broker.publish({
      type: "project.registered",
      projectId: project.projectId,
      data: { root: project.root, availability: project.availability },
    });
    return project;
  }

  async reconcileProjects(): Promise<RegisteredProject[]> {
    this.requireRunning();
    const projects = await this.registry.reconcile();
    for (const project of projects)
      this.broker.publish({
        type: "project.reconciled",
        projectId: project.projectId,
        data: { availability: project.availability },
      });
    return projects;
  }

  registerActiveWork(work: WorkRegistration): () => void {
    this.requireRunning();
    this.activeWork.set(work.runId, work);
    return () => this.activeWork.delete(work.runId);
  }

  private requireRunning(): void {
    if (!this.metadata) throw new Error("SWF service is not running");
  }

  private async project(projectId: string): Promise<RegisteredProject> {
    const project = (await this.registry.list()).find(
      (candidate) => candidate.projectId === projectId,
    );
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (project.availability !== "available")
      throw new Error(`Project ${projectId} is ${project.availability}`);
    if (!(await this.projectTrust(project.root)))
      throw new Error(`Project ${projectId} is no longer trusted`);
    return project;
  }

  private async runStore(
    projectId: string,
  ): Promise<{ project: RegisteredProject; store: RunEventStore }> {
    const project = await this.project(projectId);
    return {
      project,
      store: new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      }),
    };
  }

  private async listRuns(project: RegisteredProject): Promise<Run[]> {
    try {
      const entries = await readdir(join(project.stateDirectory, "runs"), {
        withFileTypes: true,
      });
      const store = new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      });
      return (
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) =>
              store
                .load(entry.name)
                .then((loaded) => loaded.state.run)
                .catch(() => undefined),
            ),
        )
      ).filter((run): run is Run => run !== undefined);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private summarizeCosts(invocations: RunState["invocations"]): {
    exactUsd: number;
    estimatedUsd: number;
    unknown: number;
  } {
    return Object.values(invocations).reduce(
      (summary, invocation) => {
        const amount = invocation.cost.amountUsd;
        if (amount === undefined || invocation.cost.quality === "unknown")
          summary.unknown += 1;
        else if (invocation.cost.quality === "estimated")
          summary.estimatedUsd += amount;
        else summary.exactUsd += amount;
        return summary;
      },
      { exactUsd: 0, estimatedUsd: 0, unknown: 0 },
    );
  }

  private async budgetUsage(): Promise<BudgetUsage[]> {
    const usage: BudgetUsage[] = [];
    for (const project of await this.registry.reconcile()) {
      if (project.availability !== "available") continue;
      const store = new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      });
      for (const run of await this.listRuns(project)) {
        const state = (await store.load(run.runId)).state;
        for (const invocation of Object.values(state.invocations))
          usage.push({
            invocationId: invocation.invocationId,
            projectId: project.projectId,
            runId: run.runId,
            phaseId: invocation.phaseId,
            costUsd: invocation.cost.amountUsd,
            costQuality: invocation.cost.quality,
            tokens: invocation.usage?.totalTokens,
          });
      }
    }
    return usage;
  }

  private async budgetReport(
    projectId: string,
    runId: string,
    phaseId?: string,
  ) {
    const { project, store } = await this.runStore(projectId);
    const state = (await store.load(runId)).state;
    const location = await findProjectRoot(project.root);
    if (!location?.initialized)
      throw new Error("Budget evaluation requires initialized configuration");
    const settings = await loadProjectDeliverySettings(
      location,
      state.run.workflowId,
      state.run.policyId ?? "manual",
    );
    const configured = settings.config.budgets ?? {};
    const configuration: BudgetConfiguration = {
      ...configured,
      service: this.serviceBudget,
      phase:
        configured.phase ??
        (settings.policy.budgetUsd !== undefined ||
        settings.policy.budgetTokens !== undefined
          ? {
              maxCostUsd: settings.policy.budgetUsd,
              maxTokens: settings.policy.budgetTokens,
              strictUnknown: true,
            }
          : undefined),
    };
    return evaluateBudgets(configuration, await this.budgetUsage(), {
      projectId,
      runId,
      phaseId,
    });
  }

  private async operatorProjection(
    projectId: string,
    runId: string,
  ): Promise<OperatorProjection> {
    const { project, store } = await this.runStore(projectId);
    const state = (await store.load(runId)).state;
    const location = await findProjectRoot(project.root);
    if (!location?.initialized)
      throw new Error("Operator projection requires initialized configuration");
    const settings = await loadProjectDeliverySettings(
      location,
      state.run.workflowId,
      state.run.policyId ?? "manual",
    );
    const budgets = await this.budgetReport(projectId, runId).catch(() => []);
    const failures: Array<{
      category: "configuration";
      code: string;
      message: string;
      phaseId?: string;
      retryable: false;
    }> = [];
    const execution = await loadProjectExecutionSettings(
      location,
      state.run.workflowId,
      state.run.policyId ?? "manual",
    ).catch(() => undefined);
    if (execution) {
      for (const phase of execution.workflow.phases) {
        const profile = execution.profiles[phase.profile];
        if (!profile?.modelTier) continue;
        const diagnostic = diagnoseModelRoutes({
          tiers: [profile.modelTier],
          harnesses: [profile.harness ?? "pi"],
          sources: {
            project: { modelTiers: execution.modelRouting.modelTiers },
          },
        })[0];
        if (diagnostic?.status === "unresolved")
          failures.push({
            category: "configuration",
            code: "MODEL_ROUTE_UNRESOLVED",
            message:
              diagnostic.message ??
              `Model route ${diagnostic.path} is unresolved`,
            phaseId: phase.id,
            retryable: false,
          });
      }
      const metadata = await readTemplateMetadata(location.configDirectory);
      if (metadata) {
        const projectConfig = await readProjectConfig(location);
        const conflicts = (
          await inspectTemplateDiff({
            configDirectory: location.configDirectory,
            adopted: metadata,
            installed: defaultTemplateFiles(projectConfig.projectId),
          })
        ).filter(({ status }) => status === "conflict");
        if (conflicts.length)
          failures.push({
            category: "configuration",
            code: "TEMPLATE_ATTENTION_REQUIRED",
            message: `Default template conflicts require review: ${conflicts.map(({ path }) => path).join(", ")}`,
            retryable: false,
          });
      }
    }
    return buildOperatorProjection({
      state,
      workflow: settings.workflow,
      budgets,
      failures,
    });
  }

  private async overview(): Promise<unknown> {
    const projects = await this.registry.reconcile();
    const summaries = await Promise.all(
      projects.map(async (project) => {
        if (project.availability !== "available")
          return {
            ...project,
            activeRuns: 0,
            waitingGates: 0,
            failures: 0,
            recentInvocations: [],
            costs: { exactUsd: 0, estimatedUsd: 0, unknown: 0 },
          };
        const runs = await this.listRuns(project);
        const store = new RunEventStore(project.stateDirectory, {
          redaction: this.redactor,
        });
        const states = await Promise.all(
          runs.map((run) =>
            store.load(run.runId).then((loaded) => loaded.state),
          ),
        );
        const invocations = states.flatMap((state) =>
          Object.values(state.invocations),
        );
        const costs = this.summarizeCosts(
          Object.fromEntries(
            invocations.map((invocation) => [
              invocation.invocationId,
              invocation,
            ]),
          ),
        );
        return {
          ...project,
          activeRuns: runs.filter((run) =>
            ["pending", "running", "blocked", "paused"].includes(run.status),
          ).length,
          waitingGates: states.reduce(
            (count, state) =>
              count +
              Object.values(state.phases).filter(
                (phase) =>
                  phase.gate?.status === "blocked" ||
                  (phase.status === "blocked" &&
                    phase.gate?.status !== "rejected"),
              ).length,
            0,
          ),
          failures: runs.filter((run) => run.status === "failed").length,
          recentInvocations: invocations
            .sort((left, right) =>
              right.startedAt.localeCompare(left.startedAt),
            )
            .slice(0, 5),
          costs,
        };
      }),
    );
    return {
      projects: summaries,
      totals: summaries.reduce(
        (total, project) => ({
          projects: total.projects + 1,
          activeRuns: total.activeRuns + project.activeRuns,
          waitingGates: total.waitingGates + project.waitingGates,
          failures: total.failures + project.failures,
          exactUsd: total.exactUsd + project.costs.exactUsd,
          estimatedUsd: total.estimatedUsd + project.costs.estimatedUsd,
          unknown: total.unknown + project.costs.unknown,
        }),
        {
          projects: 0,
          activeRuns: 0,
          waitingGates: 0,
          failures: 0,
          exactUsd: 0,
          estimatedUsd: 0,
          unknown: 0,
        },
      ),
    };
  }

  private runReferencePath(
    project: RegisteredProject,
    runId: string,
    reference: string,
  ): string {
    const root = resolve(project.stateDirectory, "runs", runId);
    const path = resolve(root, reference);
    const pathRelative = relative(root, path);
    if (
      !reference ||
      pathRelative.startsWith("..") ||
      pathRelative === "" ||
      resolve(path) === root
    )
      throw new Error("Output reference must remain inside the selected run");
    return path;
  }

  private async readOutput(
    project: RegisteredProject,
    runId: string,
    reference: string,
    raw = false,
  ): Promise<unknown> {
    const path = this.runReferencePath(project, runId, reference);
    try {
      const root = await realpath(
        resolve(project.stateDirectory, "runs", runId),
      );
      const canonicalPath = await realpath(path);
      if (relative(root, canonicalPath).startsWith(".."))
        throw new Error("Output reference resolves outside the selected run");
      const info = await stat(canonicalPath);
      if (!info.isFile()) throw new Error("Output reference is not a file");
      const maximum = raw ? 5 * 1024 * 1024 : 32 * 1024;
      const contents = await readFile(canonicalPath);
      const returned = contents.subarray(0, maximum);
      return {
        ref: reference,
        available: true,
        content: this.redactor.text(returned.toString("utf8")),
        bytes: contents.byteLength,
        returnedBytes: returned.byteLength,
        truncated: contents.byteLength > returned.byteLength,
        raw,
      };
    } catch (error) {
      if (isNotFound(error))
        return {
          ref: reference,
          available: false,
          reason: "Output was pruned by retention policy or is unavailable",
        };
      throw error;
    }
  }

  async query(query: ServiceQuery): Promise<unknown> {
    return this.redactor.value(await this.queryUnredacted(query));
  }

  private async queryUnredacted(query: ServiceQuery): Promise<unknown> {
    this.requireRunning();
    if (query.resource === "overview") return this.overview();
    if (query.resource === "adapters")
      return Promise.all(
        this.harnessAdapters.map(async (adapter) => {
          const availability = await adapter.availability().catch((error) => ({
            valid: false,
            errors: [
              error instanceof Error
                ? error.message
                : "adapter diagnostics failed",
            ],
          }));
          return {
            id: adapter.id,
            available: availability.valid,
            errors: availability.errors,
            capabilities: adapter.capabilities,
          };
        }),
      );
    if (query.resource === "projects") return this.registry.reconcile();
    if (query.resource === "blocked-inputs") return this.blockedInputs();
    if (!query.projectId)
      throw new Error(`projectId is required for ${query.resource}`);
    const { project, store } = await this.runStore(query.projectId);
    if (query.resource === "explorations")
      return new ExplorationStore(project.stateDirectory).list();
    if (query.resource === "exploration") {
      if (!query.ref) throw new Error("ref is required for exploration");
      const explorations = new ExplorationStore(project.stateDirectory);
      return {
        exploration: await explorations.get(query.ref),
        events: await explorations.events(query.ref),
      };
    }
    if (query.resource === "runs") return this.listRuns(project);
    if (query.resource === "operations")
      return inspectOperationalHealth(
        project.stateDirectory,
        this.stuckAfterMs,
      );
    if (query.resource === "configuration") {
      const location = await findProjectRoot(project.root);
      return {
        project,
        initialized: location?.initialized ?? false,
        validationIssues: location
          ? await validateProjectConfiguration(location)
          : [{ path: project.root, message: "project root unavailable" }],
      };
    }
    if (query.resource === "check-discovery")
      return discoverProjectChecks(project.root);
    if (query.resource === "defaults") {
      const location = await findProjectRoot(project.root);
      if (!location?.initialized)
        return { initialized: false, metadata: undefined, diff: [] };
      const metadata = await readTemplateMetadata(location.configDirectory);
      const projectConfig = await readProjectConfig(location);
      const installed = defaultTemplateFiles(projectConfig.projectId);
      return {
        initialized: true,
        metadata,
        diff: await inspectTemplateDiff({
          configDirectory: location.configDirectory,
          adopted: metadata,
          installed,
        }),
        note: "Installed defaults are inspected through an explicit preview; no project files are changed by this query.",
      };
    }
    if (query.resource === "model-routes") {
      const location = await findProjectRoot(project.root);
      if (!location?.initialized) throw new Error("Project is not initialized");
      const projectConfig = await readProjectConfig(location);
      const settings = await loadProjectExecutionSettings(
        location,
        projectConfig.defaultWorkflow,
        "manual",
      );
      const tiers = [
        ...new Set(
          settings.workflow.phases
            .map((phase) => settings.profiles[phase.profile]?.modelTier)
            .filter((tier): tier is string => Boolean(tier)),
        ),
      ];
      const harnesses = [
        ...new Set(
          settings.workflow.phases.map(
            (phase) => settings.profiles[phase.profile]?.harness ?? "pi",
          ),
        ),
      ];
      return diagnoseModelRoutes({
        tiers,
        harnesses,
        sources: { project: { modelTiers: settings.modelRouting.modelTiers } },
      });
    }
    if (!query.runId)
      throw new Error(`runId is required for ${query.resource}`);
    if (query.resource === "output") {
      if (!query.ref) throw new Error("ref is required for output");
      return this.readOutput(project, query.runId, query.ref, query.raw);
    }
    const loaded = await store.load(query.runId);
    if (query.resource === "operator-projection")
      return this.operatorProjection(query.projectId, query.runId);
    if (query.resource === "phase-explanation")
      return this.queryUnredacted({ ...query, resource: "phases" });
    switch (query.resource) {
      case "run": {
        const runtime = await readJson<Record<string, unknown>>(
          join(project.stateDirectory, "runs", query.runId, "runtime.json"),
        );
        return {
          ...loaded,
          runtime,
          costs: this.summarizeCosts(loaded.state.invocations),
        };
      }
      case "phases": {
        if (!query.phaseId) return loaded.state.phases;
        const location = await findProjectRoot(project.root);
        if (!location?.initialized)
          throw new Error("Project is not initialized");
        const settings = await loadProjectExecutionSettings(
          location,
          loaded.state.run.workflowId,
          loaded.state.run.policyId ?? "manual",
        );
        const phase = settings.workflow.phases.find(
          ({ id }) => id === query.phaseId,
        );
        if (!phase) throw new Error(`Unknown phase: ${query.phaseId}`);
        const profile = settings.profiles[phase.profile];
        const adapter = this.adapter(profile?.harness ?? "pi");
        const manifest = await new ArtifactStore(
          project.stateDirectory,
          query.runId,
          this.redactor,
        ).load();
        const budget = await this.budgetReport(
          query.projectId,
          query.runId,
          query.phaseId,
        );
        const route =
          profile && phase.work.some(({ type }) => type === "agent")
            ? resolveModelRoute({
                harness: profile.harness ?? "pi",
                sources: {
                  project: { modelTiers: settings.modelRouting.modelTiers },
                  phase: {
                    model: phase.model ?? profile.model,
                    modelTier: phase.modelTier ?? profile.modelTier,
                  },
                },
                model: phase.model ?? profile.model,
                modelTier: phase.modelTier ?? profile.modelTier,
              }).route
            : undefined;
        return {
          phase: loaded.state.phases[query.phaseId],
          explanation: explainPhaseContract({
            phaseId: query.phaseId,
            contract: profile?.contract ?? phaseContractFor(query.phaseId),
            modelRoute: route,
            tools: phase.work.map(({ type }) => type),
            evidenceRefs: manifest.artifacts
              .filter(
                ({ phaseId: artifactPhase, status }) =>
                  artifactPhase === query.phaseId && status === "valid",
              )
              .map(({ outputRef }) => outputRef),
            provenance: {
              contract: profile?.contract
                ? `profile:${profile.id}`
                : "built-in",
              model: route?.source ?? "deterministic",
            },
          }),
          eligibility: evaluatePhaseEligibility(
            settings.workflow,
            query.phaseId,
            {
              state: loaded.state,
              activePhaseId: Object.values(loaded.state.phases).find(
                ({ status }) => status === "running",
              )?.id,
              worktreeAtCheckpoint: true,
              artifactsValid: !manifest.artifacts.some(
                ({ status }) => status === "invalid" || status === "missing",
              ),
              entryChecksPass: !Object.values(
                loaded.state.phases[query.phaseId]?.checks ?? {},
              ).some(({ status }) => status === "failed"),
              policyAllows: true,
              budgetAvailable: budget.every(({ allowed }) => allowed),
              adapter,
            },
          ),
        };
      }
      case "invocations":
        return loaded.state.invocations;
      case "artifacts":
        return (
          await new ArtifactStore(
            project.stateDirectory,
            query.runId,
            this.redactor,
          ).load()
        ).artifacts;
      case "approvals": {
        const directory = join(
          project.stateDirectory,
          "runs",
          query.runId,
          "approvals",
        );
        try {
          return Promise.all(
            (await readdir(directory))
              .filter((entry) => entry.endsWith(".json"))
              .map((entry) => readJson(join(directory, entry))),
          );
        } catch (error) {
          if (isNotFound(error)) return [];
          throw error;
        }
      }
      case "delivery":
        return loaded.state.deliveries;
      case "costs":
        return this.summarizeCosts(loaded.state.invocations);
      case "budgets":
        return this.budgetReport(query.projectId, query.runId, query.phaseId);
      default:
        throw new Error(
          `Unsupported query resource: ${query.resource satisfies never}`,
        );
    }
  }

  private async rawOutputFiles(
    project: RegisteredProject,
    criteria: PruningCriteria,
  ): Promise<
    Array<{
      runId: string;
      ref: string;
      path: string;
      bytes: number;
      modifiedAt: string;
    }>
  > {
    const runs = criteria.runId
      ? [criteria.runId]
      : (await this.listRuns(project)).map((run) => run.runId);
    const files: Array<{
      runId: string;
      ref: string;
      path: string;
      bytes: number;
      modifiedAt: string;
    }> = [];
    const walk = async (
      runId: string,
      directory: string,
      prefix: string,
    ): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const ref = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(runId, path, ref);
        else if (entry.isFile()) {
          const info = await stat(path);
          files.push({
            runId,
            ref,
            path,
            bytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
      }
    };
    for (const runId of runs)
      await walk(
        runId,
        join(project.stateDirectory, "runs", runId, "raw"),
        "raw",
      );
    return files;
  }

  async previewPruning(
    projectId: string,
    criteria: PruningCriteria,
  ): Promise<PruningPreview> {
    this.requireRunning();
    if (
      criteria.ageDays === undefined &&
      criteria.runId === undefined &&
      criteria.budgetBytes === undefined
    )
      throw new Error(
        "Pruning requires an age, selected run, or storage budget",
      );
    if (
      criteria.ageDays !== undefined &&
      (!Number.isFinite(criteria.ageDays) || criteria.ageDays < 0)
    )
      throw new Error("ageDays must be a non-negative number");
    if (
      criteria.budgetBytes !== undefined &&
      (!Number.isSafeInteger(criteria.budgetBytes) || criteria.budgetBytes < 0)
    )
      throw new Error("budgetBytes must be a non-negative integer");
    const project = await this.project(projectId);
    const files = (await this.rawOutputFiles(project, criteria)).sort(
      (left, right) => left.modifiedAt.localeCompare(right.modifiedAt),
    );
    const cutoff =
      criteria.ageDays === undefined
        ? undefined
        : Date.now() - criteria.ageDays * 86_400_000;
    const eligible = files.filter(
      (file) =>
        cutoff === undefined || new Date(file.modifiedAt).getTime() <= cutoff,
    );
    let candidates = eligible;
    if (criteria.budgetBytes !== undefined) {
      const bytesToRemove = Math.max(
        0,
        files.reduce((sum, file) => sum + file.bytes, 0) - criteria.budgetBytes,
      );
      let selectedBytes = 0;
      candidates = eligible.filter((file) => {
        if (selectedBytes >= bytesToRemove) return false;
        selectedBytes += file.bytes;
        return true;
      });
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          criteria,
          candidates: candidates.map(({ runId, ref, bytes, modifiedAt }) => ({
            runId,
            ref,
            bytes,
            modifiedAt,
          })),
        }),
      )
      .digest("base64url")
      .slice(0, 16);
    const confirmationId = `${randomUUID()}.${digest}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const preview: PendingPruning = {
      schemaVersion: 1,
      confirmationId,
      criteria,
      candidates: candidates.map(({ runId, ref, bytes, modifiedAt }) => ({
        runId,
        ref,
        bytes,
        modifiedAt,
      })),
      totalBytes: candidates.reduce((sum, file) => sum + file.bytes, 0),
      expiresAt,
      projectId,
      paths: candidates.map((file) => file.path),
    };
    this.pendingPruning.set(confirmationId, preview);
    return {
      schemaVersion: preview.schemaVersion,
      confirmationId: preview.confirmationId,
      criteria: preview.criteria,
      candidates: preview.candidates,
      totalBytes: preview.totalBytes,
      expiresAt: preview.expiresAt,
    };
  }

  async confirmPruning(
    projectId: string,
    confirmationId: string,
  ): Promise<{ pruned: number; bytes: number }> {
    this.requireRunning();
    const preview = this.pendingPruning.get(confirmationId);
    if (
      !preview ||
      preview.projectId !== projectId ||
      new Date(preview.expiresAt).getTime() < Date.now()
    )
      throw new Error(
        "Pruning confirmation is missing or expired; request a fresh preview",
      );
    let pruned = 0;
    let bytes = 0;
    for (const [index, path] of preview.paths.entries()) {
      const candidate = preview.candidates[index];
      let removed = false;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        await rm(path);
        removed = true;
        pruned += 1;
        bytes += info.size;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (candidate && removed) {
        const project = await this.project(projectId);
        const prunedAt = new Date().toISOString();
        await new ArtifactStore(
          project.stateDirectory,
          candidate.runId,
          this.redactor,
        ).markRawOutputPruned(candidate.ref, prunedAt);
        const ledgerPath = join(
          project.stateDirectory,
          "runs",
          candidate.runId,
          "retention.jsonl",
        );
        const ledger = await open(ledgerPath, "a", 0o600);
        try {
          await ledger.writeFile(
            `${JSON.stringify({ schemaVersion: 1, type: "raw-output.pruned", prunedAt, ref: candidate.ref, bytes: candidate.bytes, confirmationId })}\n`,
          );
          await ledger.sync();
        } finally {
          await ledger.close();
        }
        this.broker.publish({
          type: "output.pruned",
          projectId,
          runId: candidate.runId,
          data: { ref: candidate.ref, bytes: candidate.bytes },
        });
      }
    }
    await this.audit.append({
      operation: "output.prune",
      actor: { type: "user", id: "operator" },
      projectId,
      outcome: "completed",
      details: { confirmationId, pruned, bytes, criteria: preview.criteria },
    });
    this.pendingPruning.delete(confirmationId);
    return { pruned, bytes };
  }

  private async deliveryRequest(
    projectId: string,
    runId: string,
    options: { preflightOnly?: boolean } = {},
  ): Promise<{
    request: DeliveryRequest;
    existing?: RunState["deliveries"][string];
  }> {
    const { project, store } = await this.runStore(projectId);
    const loaded = await store.load(runId);
    const location = await findProjectRoot(project.root);
    if (!location?.initialized)
      throw new Error("Delivery requires initialized project configuration");
    const recordedAuthorization = await readJson<ApprovalAuthorization>(
      join(project.stateDirectory, "runs", runId, "authorization.json"),
    );
    const delegatedAuthorization =
      loaded.events.some(
        (event) =>
          event.type === "gate.decided" &&
          event.context.phaseId === "releasing" &&
          event.actor.type === "policy" &&
          event.data.status === "satisfied",
      ) ||
      Boolean(
        recordedAuthorization &&
        (!recordedAuthorization.expiresAt ||
          new Date(recordedAuthorization.expiresAt).getTime() > Date.now()),
      );
    const policyId =
      loaded.state.run.policyId ??
      (delegatedAuthorization ? "autonomous" : "manual");
    const settings = await loadProjectDeliverySettings(
      location,
      loaded.state.run.workflowId,
      policyId,
    );
    const plan = resolveDeliveryPlan({
      configuredMode: settings.workflow.delivery.mode,
      mergeMethod: settings.workflow.delivery.mergeMethod,
      explicitlyConfigured: true,
      authorization: {
        approvalMode:
          settings.policy.approvalMode === "automatic" ? "automatic" : "manual",
        delegatedAuthorization:
          delegatedAuthorization ||
          Boolean(
            options.preflightOnly &&
            settings.policy.approvalMode === "automatic",
          ),
        directMergeAuthorized: settings.policy.allowDirectMerge === true,
      },
    });
    const runtime = await readJson<{ branch?: string; worktreePath?: string }>(
      join(project.stateDirectory, "runs", runId, "runtime.json"),
    );
    const checkpoints = Object.values(loaded.state.checkpoints).sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
    const existing = Object.values(loaded.state.deliveries)[0];
    return {
      existing,
      request: {
        cwd: options.preflightOnly
          ? project.root
          : (runtime?.worktreePath ??
            join(project.stateDirectory, "worktrees", runId)),
        remote: settings.config.git.remote,
        sourceBranch: runtime?.branch ?? `swf/${runId}`,
        targetBranch: settings.config.git.targetBranch,
        title: `[SWF] ${loaded.state.run.changeName}`,
        body: `${loaded.state.run.description}\n\nRun: ${runId}\nOpenSpec change: ${loaded.state.run.changeName}`,
        runId,
        deliveryId: existing?.deliveryId,
        executionStatus: loaded.state.run.status,
        sourceCommit: checkpoints[0]?.afterCommit ?? "unknown",
        phaseId: settings.workflow.phases.at(-1)!.id,
        plan,
        failureAction: settings.policy.deliveryFailureAction ?? "escalate",
      },
    };
  }

  private async recordDeliveryUpdate(
    projectId: string,
    request: DeliveryRequest,
    update: DeliveryUpdate,
  ): Promise<void> {
    const { project } = await this.runStore(projectId);
    if (update.kind === "cleanup" && update.delivery.status === "merged") {
      const ownership = await new RuntimeOwnershipStore(
        project.stateDirectory,
      ).load(request.runId);
      const ownedResources =
        (ownership?.resources ?? []).map(
          ({ kind, resourceId }) => `${kind}:${resourceId}`,
        ) ?? [];
      try {
        const runtime = new RunRuntime(
          new GitClient(project.root, this.commandRunner),
          this.herdr,
          new RuntimeOwnershipStore(project.stateDirectory),
        );
        const removed = await runtime.cleanup(request.runId);
        update.delivery = {
          ...update.delivery,
          cleanupState: {
            status: "completed",
            ownedResources,
            removedResources: removed,
            retainedResources: [],
            updatedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        update.delivery = {
          ...update.delivery,
          cleanupState: {
            status: "preserved",
            ownedResources,
            removedResources: [],
            retainedResources: ownedResources,
            updatedAt: new Date().toISOString(),
          },
          failureReason: `Delivery succeeded but owned cleanup was preserved: ${error instanceof Error ? error.message : "cleanup failed"}`,
        };
      }
    }
    const artifact = await retainDeliveryUpdate({
      artifacts: new ArtifactStore(
        project.stateDirectory,
        request.runId,
        this.redactor,
      ),
      update,
      sourceCommit: request.sourceCommit,
      phaseId: request.phaseId,
    });
    const actor = { type: "service" as const, id: "swf-delivery" };
    await this.append(projectId, request.runId, {
      type: "artifact.recorded",
      actor,
      context: { phaseId: request.phaseId },
      data: { artifact },
    });
    await this.append(projectId, request.runId, {
      type: "delivery.recorded",
      actor,
      context: { phaseId: request.phaseId },
      data: { delivery: update.delivery },
    });
    if (update.kind === "merge")
      await this.persistRunDossier(projectId, request.runId);
    if (update.action === "remediate") {
      const { store } = await this.runStore(projectId);
      const state = (await store.load(request.runId)).state;
      if (state.run.status === "completed") {
        await this.append(projectId, request.runId, {
          type: "run.transitioned",
          actor,
          context: {},
          data: {
            from: "completed",
            to: "pending",
            reason: `delivery ${update.delivery.status}: remediation required`,
          },
        });
      }
      const attemptId = randomUUID();
      const number =
        (state.phases[request.phaseId ?? "releasing"]?.attemptIds.length ?? 0) +
        1;
      await this.append(projectId, request.runId, {
        type: "attempt.started",
        actor,
        context: { phaseId: request.phaseId, attemptId },
        data: {
          attemptId,
          phaseId: request.phaseId ?? "releasing",
          number,
          kind: "remediation",
        },
      });
      await this.append(projectId, request.runId, {
        type: "run.remediated",
        actor,
        context: { phaseId: request.phaseId, attemptId },
        data: {
          phaseId: request.phaseId ?? "releasing",
          attemptId,
          reason: update.delivery.failureReason,
        },
      });
    }
  }

  private startDeliveryMonitor(
    projectId: string,
    request: DeliveryRequest,
    delivery: RunState["deliveries"][string],
  ): void {
    if (!delivery.pullRequestNumber || this.deliveryMonitors.has(request.runId))
      return;
    const controller = new AbortController();
    this.deliveryMonitors.set(request.runId, controller);
    const orchestrator = new DeliveryOrchestrator(
      this.hostingAdapter,
      (update) => this.recordDeliveryUpdate(projectId, request, update),
    );
    void orchestrator
      .monitor({
        ...request,
        delivery,
        pollIntervalMs: this.deliveryPollIntervalMs,
        signal: controller.signal,
      })
      .catch((error) => {
        this.broker.publish({
          type: "delivery.monitor-error",
          projectId,
          runId: request.runId,
          data: {
            message:
              error instanceof Error
                ? error.message
                : "delivery monitor failed",
          },
        });
      })
      .finally(() => this.deliveryMonitors.delete(request.runId));
  }

  async preflightDelivery(
    projectId: string,
    runId: string,
  ): Promise<Awaited<ReturnType<HostingAdapter["preflight"]>>> {
    const { request } = await this.deliveryRequest(projectId, runId, {
      preflightOnly: true,
    });
    const result = await this.hostingAdapter.preflight({
      cwd: request.cwd,
      mode: request.plan.mode,
      remote: request.remote,
      targetBranch: request.targetBranch,
      sourceBranch: request.sourceBranch,
      requireMergePermission:
        request.plan.action !== "open-pull-request" &&
        request.plan.action !== "record-local-branch",
      requireAutoMerge:
        request.plan.action === "open-pull-request-and-auto-merge",
    });
    if (!result.valid) throw new DeliveryPreflightError(result);
    return result;
  }

  async deliver(
    projectId: string,
    runId: string,
    options: { refreshOnly?: boolean } = {},
  ): Promise<RunState["deliveries"][string]> {
    const project = await this.project(projectId);
    const { request, existing } = await this.deliveryRequest(projectId, runId);
    if (!options.refreshOnly && request.executionStatus !== "completed")
      throw new Error("Pull-request delivery requires completed execution");
    // Runs created by older integrations can lack a durable source checkpoint
    // and may use a hosting-only fixture instead of a real Git worktree. In
    // that case there is no trustworthy local commit to preflight; preserve
    // the existing hosting delivery path and let the adapter perform its own
    // admission checks. Real runs always have a checkpoint and take the
    // deterministic local preflight path below.
    if (!options.refreshOnly && request.sourceCommit !== "unknown") {
      const git = new GitClient(request.cwd, this.commandRunner);
      const preflight = await releasePreflight({
        runId,
        git,
        runner: this.commandRunner,
        sourceBranch: request.sourceBranch,
        targetBranch: request.targetBranch,
        remote: request.remote,
        mergeMethod: request.plan.mergeMethod,
        expectedSourceCommit: request.sourceCommit,
        requireCleanSource: true,
        refreshTarget: true,
      });
      if (!preflight.valid)
        throw new Error(
          `Release preflight failed: ${preflight.checks
            .filter(({ status }) => status !== "passed")
            .map(({ detail }) => detail)
            .join("; ")}`,
        );
      request.preflight = preflight;
      const artifacts = new ArtifactStore(
        project.stateDirectory,
        runId,
        this.redactor,
      );
      const preflightOutput = await artifacts.retainRaw(
        `release/final-preflight-${runId}.json`,
        `${JSON.stringify(preflight, null, 2)}\n`,
      );
      const preflightArtifact = await artifacts.record({
        schemaVersion: 1,
        artifactId: randomUUID(),
        runId,
        type: "release-preflight",
        phaseId: request.phaseId ?? "releasing",
        sourceCommit: preflight.sourceCommit,
        inputFingerprint: releasePreflightFingerprint(preflight),
        status: "valid",
        createdAt: new Date().toISOString(),
        outputRef: preflightOutput,
        summary: "Final release preflight passed before delivery mutation",
        consumers: [],
      });
      await this.append(projectId, runId, {
        type: "artifact.recorded",
        actor: { type: "service", id: "swf-release" },
        context: { phaseId: request.phaseId },
        data: { artifact: preflightArtifact },
      });
      await this.persistRunDossier(projectId, runId);
    }
    const orchestrator = new DeliveryOrchestrator(
      this.hostingAdapter,
      (update) => this.recordDeliveryUpdate(projectId, request, update),
    );
    if (options.refreshOnly) {
      if (!existing) throw new Error("No delivery exists to refresh");
      return orchestrator.monitor({
        ...request,
        delivery: existing,
        pollIntervalMs: 0,
        maxPolls: 1,
      });
    }
    let delivery = await orchestrator.start(request);
    if (delivery.mode === "direct-merge" && delivery.status === "merged") {
      const merged = await this.commandRunner.run(
        "git",
        ["rev-parse", request.targetBranch],
        { cwd: project.root },
      );
      if (merged.code === 0) {
        delivery = {
          ...delivery,
          resultingCommit: merged.stdout.trim(),
          updatedAt: new Date().toISOString(),
        };
        await this.recordDeliveryUpdate(projectId, request, {
          delivery,
          kind: "merge",
        });
      }
    }
    this.startDeliveryMonitor(projectId, request, delivery);
    return delivery;
  }

  private adapter(id: string): HarnessAdapter {
    const adapter = this.harnessAdapters.find(
      (candidate) => candidate.id === id,
    );
    if (!adapter) throw new Error(`No harness adapter is configured for ${id}`);
    return adapter;
  }

  private async prepareRun(input: {
    project: RegisteredProject;
    changeName: string;
    description: string;
    workflowId?: string;
    policyId?: string;
    authorization?: ApprovalAuthorization;
  }): Promise<{
    run: Run;
    settings: Awaited<ReturnType<typeof loadProjectExecutionSettings>>;
    runtime: Awaited<ReturnType<RunRuntime["prepare"]>>;
    location: NonNullable<Awaited<ReturnType<typeof findProjectRoot>>>;
  }> {
    const location = await findProjectRoot(input.project.root);
    if (!location?.initialized)
      throw new Error("Run creation requires an initialized SWF project");
    const issues = await validateProjectConfiguration(location);
    if (issues.length)
      throw new Error(
        `Project configuration is invalid: ${issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
      );
    const config = await readProjectConfig(location);
    if (config.projectId !== input.project.projectId)
      throw new Error(
        `Registered project identity ${input.project.projectId} does not match ${config.projectId}`,
      );
    const workflowId = input.workflowId ?? config.defaultWorkflow;
    const policyId = input.policyId ?? "manual";
    const settings = await loadProjectExecutionSettings(
      location,
      workflowId,
      policyId,
    );
    for (const phase of settings.workflow.phases) {
      if (!phase.work.some((unit) => unit.type === "agent")) continue;
      const profile = settings.profiles[phase.profile];
      if (!profile) throw new Error(`Missing phase profile: ${phase.profile}`);
      const adapter = this.adapter(profile.harness ?? "pi");
      const route = resolveModelRoute({
        harness: adapter.id,
        sources: {
          project: { modelTiers: settings.modelRouting.modelTiers },
          phase: { model: profile.model, modelTier: profile.modelTier },
        },
        model: profile.model,
        modelTier: profile.modelTier,
      }).route;
      const availability = await adapter.availability();
      if (!availability.valid)
        throw new Error(
          `Harness ${adapter.id} is unavailable for phase ${phase.id}: ${availability.errors.join("; ")}`,
        );
      const routeValidation = validateModelRouteCapabilities(
        route,
        adapter,
        phase.requiredCapabilities,
      );
      const validation = await adapter.validate(
        { model: route.concreteModel },
        phase.requiredCapabilities,
      );
      if (!routeValidation.valid || !validation.valid)
        throw new Error(
          `Harness ${adapter.id} is invalid for phase ${phase.id}: ${[...routeValidation.errors, ...validation.errors].join("; ")}`,
        );
    }

    const store = new RunEventStore(input.project.stateDirectory, {
      redaction: this.redactor,
    });
    const changeIdentity = `openspec/changes/${input.changeName}`;
    const existing = await store.findRunByChangeIdentity(changeIdentity);
    if (existing)
      throw new Error(
        `OpenSpec change ${input.changeName} is already bound to run ${existing}; use swf run, swf next, or status`,
      );
    const runId = randomUUID();
    if (settings.policy.approvalMode === "automatic" && !input.authorization)
      throw new Error(
        "Autonomous policy requires explicit recorded human authorization",
      );
    const run = await store.create({
      projectId: input.project.projectId,
      runId,
      changeName: input.changeName,
      changeIdentity,
      workflowId,
      policyId,
      description: input.description,
      phaseIds: settings.workflow.phases.map(({ id }) => id),
    });

    if (input.authorization) {
      await writeAtomically(
        join(
          input.project.stateDirectory,
          "runs",
          run.runId,
          "authorization.json",
        ),
        `${JSON.stringify(input.authorization, null, 2)}\n`,
      );
    }
    await this.preflightDelivery(input.project.projectId, run.runId);
    const runtimeManager = new RunRuntime(
      new GitClient(input.project.root, this.commandRunner),
      this.herdr,
      new RuntimeOwnershipStore(input.project.stateDirectory),
    );
    const runtime = await runtimeManager.prepare({
      runId: run.runId,
      stateDirectory: input.project.stateDirectory,
    });
    const scaffold = await this.commandRunner.run(
      "openspec",
      ["new", "change", input.changeName, "--json"],
      { cwd: runtime.worktree.path },
    );
    if (scaffold.code !== 0)
      throw new Error(
        `Unable to create OpenSpec change scaffold: ${scaffold.stderr.trim() || scaffold.stdout.trim()}`,
      );
    return { run, settings, runtime, location };
  }

  private async executePhase(input: {
    project: RegisteredProject;
    runId: string;
    phaseId: string;
    settings: Awaited<ReturnType<typeof loadProjectExecutionSettings>>;
    runtime: Awaited<ReturnType<RunRuntime["prepare"]>>;
  }): Promise<"completed" | "blocked" | "failed"> {
    const { project, runId, phaseId, settings, runtime } = input;
    const store = new RunEventStore(project.stateDirectory, {
      redaction: this.redactor,
    });
    const loaded = await store.load(runId);
    const phase = settings.workflow.phases.find(({ id }) => id === phaseId);
    if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
    const profile = settings.profiles[phase.profile];
    if (!profile) throw new Error(`Missing phase profile: ${phase.profile}`);
    if (
      phaseId === "releasing" &&
      !phase.work.some(({ type }) => type === "agent")
    )
      return this.executeDeterministicReleasePhase(
        input,
        phase,
        loaded.state.run.policyId === "autonomous",
      );
    if (phaseId === "verifying")
      assertChecksAdopted({
        expectedCodeVerification: true,
        checks: phase.checks,
      });
    const adapter = this.adapter(profile.harness ?? "pi");
    const route = resolveModelRoute({
      harness: adapter.id,
      sources: {
        project: { modelTiers: settings.modelRouting.modelTiers },
        phase: { model: profile.model, modelTier: profile.modelTier },
      },
      model: profile.model,
      modelTier: profile.modelTier,
    }).route;
    const artifacts = new ArtifactStore(
      project.stateDirectory,
      runId,
      this.redactor,
    );
    const git = new GitClient(runtime.worktree.path, this.commandRunner);
    const [gitStatus, head, manifest, budgets] = await Promise.all([
      git.status(),
      git.head(),
      artifacts.load(),
      this.budgetReport(project.projectId, runId, phaseId),
    ]);
    const phasePosition = settings.workflow.phases.findIndex(
      ({ id }) => id === phaseId,
    );
    const predecessorIds = settings.workflow.phases
      .slice(0, phasePosition)
      .map(({ id }) => id);
    const latestCheckpoint = Object.values(loaded.state.checkpoints)
      .filter(({ phaseId: checkpointPhase }) =>
        predecessorIds.includes(checkpointPhase),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const eligibility = evaluatePhaseEligibility(settings.workflow, phaseId, {
      state: loaded.state,
      worktreeAtCheckpoint:
        !latestCheckpoint ||
        (latestCheckpoint.afterCommit === head && gitStatus.clean),
      artifactsValid: !manifest.artifacts.some(
        ({ phaseId: artifactPhase, status }) =>
          predecessorIds.includes(artifactPhase) &&
          (status === "stale" || status === "invalid" || status === "missing"),
      ),
      entryChecksPass: true,
      policyAllows: true,
      budgetAvailable: budgets.every(({ allowed }) => allowed),
      adapter,
    });
    if (!eligibility.eligible)
      throw new Error(
        `Phase ${phaseId} is ineligible: ${eligibility.reasons.join("; ")}`,
      );

    const actor = { type: "service" as const, id: "swf-scheduler" };
    const attemptId = randomUUID();
    const attemptNumber =
      (loaded.state.phases[phaseId]?.attemptIds.length ?? 0) + 1;
    await this.append(project.projectId, runId, {
      type: "phase.transitioned",
      actor,
      context: { phaseId },
      data: {
        phaseId,
        from: loaded.state.phases[phaseId]!.status,
        to: "running",
      },
    });
    const attemptKind = attemptNumber === 1 ? "initial" : "retry";
    await this.append(project.projectId, runId, {
      type: "attempt.started",
      actor,
      context: { phaseId, attemptId },
      data: { attemptId, phaseId, number: attemptNumber, kind: attemptKind },
    });
    if (attemptKind === "retry")
      await this.append(project.projectId, runId, {
        type: "run.retried",
        actor,
        context: { phaseId, attemptId },
        data: { phaseId, attemptId, reason: "bounded phase retry" },
      });

    const beforeCommit = head;
    let active:
      { adapter: HarnessAdapter; invocation: AdapterInvocation } | undefined;
    const registry = new AdapterRegistry();
    for (const candidate of this.harnessAdapters) registry.register(candidate);
    const fallback = {
      execute: async (unit: (typeof phase.work)[number]) => {
        if (unit.type === "human")
          return { status: "blocked" as const, output: "Human input required" };
        if (unit.type === "command") {
          if (!unit.command)
            return {
              status: "failed" as const,
              output: "Command work requires command",
            };
          const result = await this.commandRunner.run(
            "/bin/sh",
            ["-lc", unit.command],
            {
              cwd: runtime.worktree.path,
            },
          );
          return {
            status:
              result.code === 0 ? ("completed" as const) : ("failed" as const),
            output: `${result.stdout}${result.stderr}`,
          };
        }
        if (unit.type === "openspec") {
          const result = await this.commandRunner.run(
            "openspec",
            ["validate", loaded.state.run.changeName],
            { cwd: runtime.worktree.path },
          );
          return {
            status:
              result.code === 0 ? ("completed" as const) : ("failed" as const),
            output: `${result.stdout}${result.stderr}`,
          };
        }
        return {
          status: "failed" as const,
          output: `No executor for ${unit.type}`,
        };
      },
    };
    const downstreamContext = await artifacts.selectContext({
      phaseIds: predecessorIds,
    });
    const guidelineText = [...phase.guidelines, ...profile.guidelines]
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => settings.guidelines[id])
      .filter(Boolean)
      .join("\n\n");
    const contract = profile.contract ?? phaseContractFor(phaseId);
    const builtPrompt = buildPhasePrompt({
      contract,
      phaseId,
      runId,
      changeName: loaded.state.run.changeName,
      cwd: runtime.worktree.path,
      guidelines: guidelineText,
      openspecContext: `OpenSpec change: ${loaded.state.run.changeName}`,
      evidence: downstreamContext.evidence.map(({ outputRef, artifactId }) => ({
        ref: outputRef,
        fingerprint: artifactId,
        valid: true,
      })),
      tools: [],
      runtimeBoundaries: [
        "Do not mutate SWF orchestration from child invocation",
        "Do not archive, merge, or deliver unless the service explicitly authorizes it",
      ],
    });
    const workflow = {
      ...settings.workflow,
      phases: settings.workflow.phases.map((candidate) =>
        candidate.id !== phaseId
          ? candidate
          : {
              ...candidate,
              work: candidate.work.map((unit) =>
                unit.type !== "agent"
                  ? unit
                  : {
                      ...unit,
                      options: {
                        ...unit.options,
                        prompt: `${String(unit.options.prompt ?? "")}\n\n${builtPrompt.prompt}`,
                        contractFingerprint: builtPrompt.contractFingerprint,
                        promptInputFingerprint: builtPrompt.inputFingerprint,
                      },
                    },
              ),
            },
      ),
    };
    const scheduler = new WorkflowScheduler(
      workflow,
      new HarnessWorkExecutor(
        registry,
        {
          runId,
          workspaceId: runtime.workspaceId,
          cwd: runtime.worktree.path,
          afterLaunch: async (launchedAdapter, invocation) => {
            active = { adapter: launchedAdapter, invocation };
          },
          onObservation: async (observedAdapter, invocation, observation) => {
            this.reportBlockedAgent(observedAdapter, invocation, observation);
          },
          afterCollect: async (invocation, result) => {
            const outputRef = await artifacts.retainRaw(
              `invocations/${invocation.invocationId}.log`,
              result.transcript,
            );
            await this.append(project.projectId, runId, {
              type: "invocation.recorded",
              actor: { type: "harness", id: adapter.id },
              context: {
                phaseId,
                workUnitId: invocation.workUnitId,
                invocationId: invocation.invocationId,
              },
              data: {
                invocation: {
                  schemaVersion: 1,
                  invocationId: invocation.invocationId,
                  runId,
                  phaseId,
                  harness: adapter.id as "pi" | "codex" | "claude" | "copilot",
                  modelTier: route.requestedTier,
                  model: route.concreteModel,
                  modelRoute: modelRouteExplanation(route),
                  contractFingerprint: builtPrompt.contractFingerprint,
                  promptInputFingerprint: builtPrompt.inputFingerprint,
                  status:
                    result.status === "unknown" ? "failed" : result.status,
                  startedAt: invocation.startedAt,
                  endedAt: new Date().toISOString(),
                  outputRef,
                  cost: {
                    amountUsd: result.usage.costUsd,
                    quality: result.usage.quality,
                  },
                  usage: result.usage,
                },
              },
            });
          },
        },
        fallback,
      ),
    );

    let resolveBoundary!: () => void;
    const safeBoundary = new Promise<void>((resolve) => {
      resolveBoundary = resolve;
    });
    this.activeWork.set(runId, {
      runId,
      projectId: project.projectId,
      safeBoundary,
      interrupt: async () => {
        if (active) await active.adapter.cancel(active.invocation);
      },
    });
    const reusableLatePlanningOutput =
      phaseId === settings.workflow.phases[0]?.id &&
      loaded.state.phases[phaseId]?.status === "failed" &&
      (
        await validatePlanningArtifacts(
          join(
            runtime.worktree.path,
            "openspec",
            "changes",
            loaded.state.run.changeName,
          ),
        )
      ).length === 0;
    let result;
    try {
      result = reusableLatePlanningOutput
        ? {
            phaseId,
            status: "completed" as const,
            work: phase.work.map(({ id }) => ({
              workUnitId: id,
              status: "completed" as const,
              output:
                "Recovered validated Planning artifacts produced by a late-settling owned invocation",
            })),
            resolved: {},
          }
        : await scheduler.executePhase(phaseId, eligibility, {
            project: {
              ...profile.options,
              harness: profile.harness ?? "pi",
              model: route.concreteModel,
              modelTier: route.requestedTier,
              modelRoute: modelRouteExplanation(route),
              timeoutMs: settings.policy.timeoutMinutes
                ? settings.policy.timeoutMinutes * 60_000
                : undefined,
              retryLimit: settings.policy.maxAttempts,
              budgetUsd: settings.policy.budgetUsd,
              artifactContext: downstreamContext.evidence.map(
                ({ outputRef }) => outputRef,
              ),
            },
          });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "phase execution failed";
      await this.append(project.projectId, runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId, attemptId },
        data: { attemptId, status: "failed", reason },
      });
      const interrupted = await store.load(runId);
      if (interrupted.state.phases[phaseId]?.status === "running")
        await this.append(project.projectId, runId, {
          type: "phase.transitioned",
          actor,
          context: { phaseId },
          data: {
            phaseId,
            from: "running",
            to: "failed",
            reason,
          },
        });
      throw error;
    } finally {
      resolveBoundary();
      this.activeWork.delete(runId);
    }

    for (const work of result.work) {
      await this.append(project.projectId, runId, {
        type: "work-unit.transitioned",
        actor,
        context: { phaseId, attemptId, workUnitId: work.workUnitId },
        data: {
          workUnitId: work.workUnitId,
          phaseId,
          to: work.status,
          attemptId,
        },
      });
    }
    if (result.status !== "completed") {
      await this.append(project.projectId, runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId, attemptId },
        data: {
          attemptId,
          status: result.status,
          reason: result.work.at(-1)?.output,
        },
      });
      await this.append(project.projectId, runId, {
        type: "phase.transitioned",
        actor,
        context: { phaseId },
        data: { phaseId, from: "running", to: result.status },
      });
      return result.status;
    }

    if (phaseId === settings.workflow.phases[0]?.id) {
      const planningErrors = await validatePlanningArtifacts(
        join(
          runtime.worktree.path,
          "openspec",
          "changes",
          loaded.state.run.changeName,
        ),
      );
      if (planningErrors.length) {
        await this.append(project.projectId, runId, {
          type: "attempt.completed",
          actor,
          context: { phaseId, attemptId },
          data: {
            attemptId,
            status: "failed",
            reason: planningErrors.join("; "),
          },
        });
        await this.append(project.projectId, runId, {
          type: "phase.transitioned",
          actor,
          context: { phaseId },
          data: {
            phaseId,
            from: "running",
            to: "failed",
            reason: planningErrors.join("; "),
          },
        });
        return "failed";
      }
    }

    const evidence: CheckEvidence[] = [];
    const currentCommit = await git.head();
    for (const check of phase.checks) {
      let checkEvidence: CheckEvidence;
      if (check.type === "command" && check.command) {
        checkEvidence = await runCommandCheck({
          runner: this.commandRunner,
          artifacts,
          request: {
            checkId: check.id,
            phaseId,
            command: "/bin/sh",
            args: ["-lc", check.command],
            configuration: check.options,
            commit: currentCommit,
            cwd: runtime.worktree.path,
          },
        });
      } else if (check.type === "openspec") {
        checkEvidence = await runOpenSpecCheck({
          runner: this.commandRunner,
          artifacts,
          checkId: check.id,
          phaseId,
          changeName: loaded.state.run.changeName,
          commit: currentCommit,
          cwd: runtime.worktree.path,
        });
      } else if (check.type === "agent" && active) {
        try {
          await active.adapter.submit(
            active.invocation,
            "Return one JSON object matching {summary:string,findings:[{id,severity,title,detail,artifactIds}]} for this phase review.",
          );
          const reviewResult = await active.adapter.collect(active.invocation);
          const review = reviewResult.transcript
            .split("\n")
            .reverse()
            .map((line) => {
              try {
                return JSON.parse(line) as unknown;
              } catch {
                return undefined;
              }
            })
            .find(Boolean);
          checkEvidence = await recordAgentReview({
            artifacts,
            checkId: check.id,
            phaseId,
            commit: currentCommit,
            inputFingerprint: createHash("sha256")
              .update(
                JSON.stringify({ check: check.id, commit: currentCommit }),
              )
              .digest("hex"),
            review,
          });
        } catch (error) {
          checkEvidence = {
            checkId: check.id,
            type: "agent",
            required: check.required,
            status: "blocked",
            deterministic: false,
            createdAt: new Date().toISOString(),
            summary:
              error instanceof Error
                ? `Invalid agent review: ${error.message}`
                : "Invalid agent review",
          };
        }
      } else {
        checkEvidence = {
          checkId: check.id,
          type: check.type,
          required: check.required,
          status: "blocked",
          deterministic: false,
          createdAt: new Date().toISOString(),
          summary: `${check.type} check requires an operator or review executor`,
        };
      }
      evidence.push({ ...checkEvidence, required: check.required });
      if (checkEvidence.artifact) {
        await this.append(project.projectId, runId, {
          type: "artifact.recorded",
          actor,
          context: { phaseId, attemptId, checkId: check.id },
          data: { artifact: checkEvidence.artifact },
        });
      }
      await this.append(project.projectId, runId, {
        type: "check.recorded",
        actor,
        context: { phaseId, attemptId, checkId: check.id },
        data: {
          checkId: check.id,
          phaseId,
          status: checkEvidence.status,
          artifactId: checkEvidence.artifact?.artifactId,
          reason: checkEvidence.summary,
        },
      });
    }
    if (phaseId === settings.workflow.phases[0]?.id) {
      const planningCheck = await runOpenSpecCheck({
        runner: this.commandRunner,
        artifacts,
        checkId: "planning-openspec",
        phaseId,
        changeName: loaded.state.run.changeName,
        commit: currentCommit,
        cwd: runtime.worktree.path,
      });
      evidence.push(planningCheck);
      await this.append(project.projectId, runId, {
        type: "artifact.recorded",
        actor,
        context: { phaseId, attemptId, checkId: planningCheck.checkId },
        data: { artifact: planningCheck.artifact! },
      });
      await this.append(project.projectId, runId, {
        type: "check.recorded",
        actor,
        context: { phaseId, attemptId, checkId: planningCheck.checkId },
        data: {
          checkId: planningCheck.checkId,
          phaseId,
          status: planningCheck.status,
          artifactId: planningCheck.artifact?.artifactId,
          reason: planningCheck.summary,
        },
      });
    }
    const gitEvidence = await artifacts.captureGitEvidence({
      phaseId,
      attemptId,
      beforeCommit,
      git,
    });
    await this.append(project.projectId, runId, {
      type: "artifact.recorded",
      actor,
      context: { phaseId, attemptId },
      data: {
        artifact: {
          ...gitEvidence.artifact,
          modelRoute: modelRouteExplanation(route),
          contractFingerprint: builtPrompt.contractFingerprint,
          promptInputFingerprint: builtPrompt.inputFingerprint,
        },
      },
    });
    const boundaryViolations = phaseMutationBoundaryViolations(
      phaseId,
      gitEvidence.evidence.changedFiles,
    );
    if (boundaryViolations.length) {
      const reason = `${phaseId} mutation boundary violated: ${boundaryViolations.join(", ")}`;
      await this.append(project.projectId, runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId, attemptId },
        data: { attemptId, status: "failed", reason },
      });
      await this.append(project.projectId, runId, {
        type: "phase.transitioned",
        actor,
        context: { phaseId },
        data: { phaseId, from: "running", to: "failed", reason },
      });
      return "failed";
    }
    if (phaseId === "verifying") {
      const verificationChecks = [...evidence];
      const strictSpec = await runOpenSpecCheck({
        runner: this.commandRunner,
        artifacts,
        checkId: "verifying-openspec",
        phaseId,
        changeName: loaded.state.run.changeName,
        commit: currentCommit,
        cwd: runtime.worktree.path,
      });
      verificationChecks.push(strictSpec);
      await this.append(project.projectId, runId, {
        type: "artifact.recorded",
        actor,
        context: { phaseId, attemptId, checkId: strictSpec.checkId },
        data: { artifact: strictSpec.artifact! },
      });
      await this.append(project.projectId, runId, {
        type: "check.recorded",
        actor,
        context: { phaseId, attemptId, checkId: strictSpec.checkId },
        data: {
          checkId: strictSpec.checkId,
          phaseId,
          status: strictSpec.status,
          artifactId: strictSpec.artifact?.artifactId,
          reason: strictSpec.summary,
        },
      });
      try {
        const reviewArtifact = verificationChecks.find(
          ({ artifact }) => artifact?.type === "agent-review",
        )?.artifact;
        const review = reviewArtifact
          ? await readJson<{
              summary: string;
              findings: Array<{
                id: string;
                severity: "info" | "warning" | "blocking";
                title: string;
                detail: string;
                artifactIds: string[];
              }>;
            }>(
              join(
                project.stateDirectory,
                "runs",
                runId,
                reviewArtifact.outputRef,
              ),
            )
          : undefined;
        const audit = await auditOpenSpecTasks({
          changeRoot: join(
            runtime.worktree.path,
            "openspec",
            "changes",
            loaded.state.run.changeName,
          ),
          sourceCommit: currentCommit,
          implementationRefs: gitEvidence?.evidence.changedFiles,
          checks: verificationChecks,
          review,
        });
        const auditArtifact = await recordTaskAudit({
          artifacts,
          phaseId,
          audit,
        });
        evidence.push({
          checkId: "task-audit",
          type: "openspec",
          required: true,
          status: audit.status === "verified" ? "passed" : "failed",
          artifact: auditArtifact,
          deterministic: true,
          createdAt: auditArtifact.createdAt,
          summary: audit.summary,
        });
        await this.append(project.projectId, runId, {
          type: "artifact.recorded",
          actor,
          context: { phaseId, attemptId, checkId: "task-audit" },
          data: { artifact: auditArtifact },
        });
      } catch (error) {
        evidence.push({
          checkId: "task-audit",
          type: "openspec",
          required: true,
          status: "failed",
          deterministic: true,
          createdAt: new Date().toISOString(),
          summary:
            error instanceof Error
              ? `Task audit failed: ${error.message}`
              : "Task audit failed",
        });
      }
    }
    const context = await artifacts.selectContext({ phaseIds: [phaseId] });
    const handoff = await requestStructuredHandoff({
      runId,
      phaseId,
      facts: context,
      agent: active
        ? {
            requestHandoff: async ({ facts, prompt }) => {
              await active!.adapter.submit(
                active!.invocation,
                `${prompt}\n${JSON.stringify({ runId, phaseId, facts })}`,
              );
              const result = await active!.adapter.collect(active!.invocation);
              for (const line of result.transcript.split("\n").reverse()) {
                try {
                  const value = JSON.parse(line) as unknown;
                  if (value && typeof value === "object") return value;
                } catch {
                  // Continue to deterministic degraded fallback.
                }
              }
              throw new Error("Phase agent returned no structured handoff");
            },
          }
        : undefined,
    });
    const handoffRef = await artifacts.retainHandoff(handoff);
    const handoffArtifact = await artifacts.record({
      schemaVersion: 1,
      artifactId: handoff.handoffId,
      runId,
      type: "phase-handoff",
      phaseId,
      sourceCommit: currentCommit,
      inputFingerprint: createHash("sha256")
        .update(JSON.stringify(context.evidence))
        .digest("hex"),
      status: "valid",
      createdAt: new Date().toISOString(),
      outputRef: handoffRef,
      producerAttemptId: attemptId,
      summary: handoff.summary.join(" ").slice(0, 2_000),
      consumers: [],
    });
    await this.append(project.projectId, runId, {
      type: "artifact.recorded",
      actor,
      context: { phaseId, attemptId },
      data: { artifact: handoffArtifact },
    });

    let gateActor: {
      type: "service" | "policy";
      id: string;
    } = actor;
    let gate =
      phase.gate.mode === "manual"
        ? { status: "blocked" as const, reasons: ["Manual approval required"] }
        : evaluateGate(
            {
              mode:
                phase.gate.mode === "advisory"
                  ? "advisory"
                  : (phase.gate.evaluation ?? "all"),
              requiredCheckIds: phase.gate.requiredChecks,
              threshold: phase.gate.threshold,
            },
            evidence,
          );
    const phaseDiff = await git.diff(beforeCommit);
    const approvalResolution = resolveApprovalMode({
      configured:
        settings.policy.approvalMode === "automatic" ? "automatic" : "manual",
      risk: {
        changedFiles: gitEvidence.evidence.changedFiles,
        sensitivePathPatterns: settings.policy.riskOverrides.includes(
          "sensitive-path",
        )
          ? [".github/**", "**/security/**", "**/auth/**", "infra/**"]
          : [],
        destructiveOperation: gitEvidence.evidence.status.files.some(
          ({ index, worktree }) => index === "D" || worktree === "D",
        ),
        secretsFound:
          settings.policy.riskOverrides.includes("secret-finding") &&
          /(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(phaseDiff),
        elevatedRisk: settings.policy.riskOverrides.includes("elevated-risk"),
        spendUsd: this.summarizeCosts(loaded.state.invocations).exactUsd,
        budgetThresholdUsd: settings.policy.budgetUsd,
      },
    });
    if (
      phase.gate.mode === "manual" &&
      approvalResolution.mode === "automatic"
    ) {
      const authorization = await readJson<ApprovalAuthorization>(
        join(project.stateDirectory, "runs", runId, "authorization.json"),
      );
      if (!authorization)
        throw new Error(
          "Delegated authorization is missing for automatic approval",
        );
      const approval = recordAutoApproval({
        runId,
        phaseId,
        authorization,
        reason: `Resolved ${settings.policy.id} policy authorized automatic phase approval`,
      });
      await writeAtomically(
        join(
          project.stateDirectory,
          "runs",
          runId,
          "approvals",
          `${approval.approvalId}.json`,
        ),
        `${JSON.stringify(approval, null, 2)}\n`,
      );
      const approvalEvidence = humanApprovalEvidence({
        checkId: `${phaseId}-approval`,
        approval,
      });
      evidence.push(approvalEvidence);
      gate = evaluateGate(
        { mode: "all", requiredCheckIds: [approvalEvidence.checkId] },
        evidence,
      );
      gateActor = { type: "policy", id: "swf-policy" };
    } else if (
      phase.gate.mode === "manual" &&
      approvalResolution.reasons.length
    ) {
      gate = {
        status: "blocked",
        reasons: approvalResolution.reasons.map(
          (reason) => `Manual approval required: ${reason}`,
        ),
      };
    }
    await this.append(project.projectId, runId, {
      type: "gate.decided",
      actor: gateActor,
      context: { phaseId, attemptId },
      data: {
        gateId: `${phaseId}-gate`,
        phaseId,
        status: gate.status,
        reason: gate.reasons.join("; ") || undefined,
      },
    });
    if (gate.status !== "satisfied" && gate.status !== "skipped") {
      const terminal = gate.status === "rejected" ? "failed" : "blocked";
      await this.append(project.projectId, runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId, attemptId },
        data: { attemptId, status: terminal, reason: gate.reasons.join("; ") },
      });
      await this.append(project.projectId, runId, {
        type: "phase.transitioned",
        actor,
        context: { phaseId },
        data: {
          phaseId,
          from: "running",
          to: terminal,
          reason: gate.reasons.join("; "),
        },
      });
      return terminal;
    }

    const checkpoint = await new CheckpointManager(
      project.stateDirectory,
      runId,
      git,
      artifacts,
    ).create({
      phaseId,
      beforeCommit,
      gateDecision: gate.status,
      handoff,
    });
    await this.append(project.projectId, runId, {
      type: "checkpoint.recorded",
      actor,
      context: { phaseId, attemptId },
      data: { checkpoint },
    });
    await this.append(project.projectId, runId, {
      type: "phase.transitioned",
      actor,
      context: { phaseId },
      data: { phaseId, from: "running", to: "completed" },
    });
    await this.append(project.projectId, runId, {
      type: "attempt.completed",
      actor,
      context: { phaseId, attemptId },
      data: { attemptId, status: "completed" },
    });
    return "completed";
  }

  private async executeDeterministicReleasePhase(
    input: {
      project: RegisteredProject;
      runId: string;
      phaseId: string;
      settings: Awaited<ReturnType<typeof loadProjectExecutionSettings>>;
      runtime: Awaited<ReturnType<RunRuntime["prepare"]>>;
    },
    phase: Awaited<
      ReturnType<typeof loadProjectExecutionSettings>
    >["workflow"]["phases"][number],
    autonomous: boolean,
  ): Promise<"completed" | "blocked" | "failed"> {
    const { project, runId, settings, runtime } = input;
    const store = new RunEventStore(project.stateDirectory, {
      redaction: this.redactor,
    });
    const loaded = await store.load(runId);
    const actor = { type: "service" as const, id: "swf-release" };
    const attemptId = randomUUID();
    await this.append(project.projectId, runId, {
      type: "phase.transitioned",
      actor,
      context: { phaseId: phase.id },
      data: {
        phaseId: phase.id,
        from: loaded.state.phases[phase.id]!.status,
        to: "running",
        reason: "deterministic release preflight",
      },
    });
    await this.append(project.projectId, runId, {
      type: "attempt.started",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: {
        attemptId,
        phaseId: phase.id,
        number: (loaded.state.phases[phase.id]?.attemptIds.length ?? 0) + 1,
        kind: "initial",
      },
    });
    const git = new GitClient(runtime.worktree.path, this.commandRunner);
    const checkpoints = Object.values(loaded.state.checkpoints).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const expectedSourceCommit =
      checkpoints[0]?.afterCommit ?? (await git.head());
    const release = await releasePreflight({
      runId,
      git,
      runner: this.commandRunner,
      sourceBranch: runtime.worktree.branch,
      targetBranch: settings.config.git.targetBranch,
      remote: settings.config.git.remote,
      mergeMethod: settings.workflow.delivery.mergeMethod,
      expectedSourceCommit,
      requireCleanSource: true,
      refreshTarget: false,
      policyChecks: [
        {
          id: "delivery-policy",
          passed: Boolean(settings.workflow.delivery.mode),
          detail: `delivery mode ${settings.workflow.delivery.mode}`,
        },
      ],
    });
    const artifacts = new ArtifactStore(
      project.stateDirectory,
      runId,
      this.redactor,
    );
    const serialized = `${JSON.stringify(release, null, 2)}\n`;
    const outputRef = await artifacts.retainRaw(
      `release/preflight-${attemptId}.json`,
      serialized,
    );
    const artifact = await artifacts.record({
      schemaVersion: 1,
      artifactId: randomUUID(),
      runId,
      type: "release-preflight",
      phaseId: phase.id,
      sourceCommit: release.sourceCommit,
      inputFingerprint: releasePreflightFingerprint(release),
      status: release.valid ? "valid" : "invalid",
      createdAt: new Date().toISOString(),
      outputRef,
      summary: summarizeReleaseApproval({
        preflight: release,
        evidence: ["strict verification", "task audit"],
        risks: release.valid
          ? []
          : release.checks
              .filter(({ status }) => status !== "passed")
              .map(({ detail }) => detail),
        cleanupPlan: ["owned runtime resources after durable delivery"],
      }),
      consumers: [],
      invalidReason: release.valid ? undefined : "release preflight failed",
    });
    await this.append(project.projectId, runId, {
      type: "artifact.recorded",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: { artifact },
    });
    const context = await artifacts.selectContext({ phaseIds: [phase.id] });
    const handoff = await requestStructuredHandoff({
      runId,
      phaseId: phase.id,
      facts: context,
    });
    const handoffRef = await artifacts.retainHandoff(handoff);
    const handoffArtifact = await artifacts.record({
      schemaVersion: 1,
      artifactId: handoff.handoffId,
      runId,
      type: "phase-handoff",
      phaseId: phase.id,
      sourceCommit: release.sourceCommit,
      inputFingerprint: releasePreflightFingerprint(release),
      status: "valid",
      createdAt: new Date().toISOString(),
      outputRef: handoffRef,
      producerAttemptId: attemptId,
      summary: handoff.summary.join(" ").slice(0, 2_000),
      consumers: [],
    });
    await this.append(project.projectId, runId, {
      type: "artifact.recorded",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: { artifact: handoffArtifact },
    });
    const gateStatus =
      release.valid &&
      (autonomous || settings.policy.approvalMode === "automatic")
        ? "satisfied"
        : release.valid
          ? "blocked"
          : "rejected";
    const gateReason = release.valid
      ? summarizeReleaseApproval({
          preflight: release,
          evidence: [artifact.outputRef],
          risks: [],
          cleanupPlan: ["retain until delivery succeeds"],
        })
      : `Release preflight failed: ${release.checks
          .filter(({ status }) => status !== "passed")
          .map(({ detail }) => detail)
          .join("; ")}`;
    await this.append(project.projectId, runId, {
      type: "gate.decided",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: {
        gateId: "releasing-gate",
        phaseId: phase.id,
        status: gateStatus,
        reason: gateReason,
      },
    });
    if (gateStatus !== "satisfied") {
      await this.append(project.projectId, runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId: phase.id, attemptId },
        data: {
          attemptId,
          status: gateStatus === "rejected" ? "failed" : "blocked",
          reason: gateReason,
        },
      });
      await this.append(project.projectId, runId, {
        type: "phase.transitioned",
        actor,
        context: { phaseId: phase.id },
        data: {
          phaseId: phase.id,
          from: "running",
          to: gateStatus === "rejected" ? "failed" : "blocked",
          reason: gateReason,
        },
      });
      return gateStatus === "rejected" ? "failed" : "blocked";
    }
    const checkpoint = await new CheckpointManager(
      project.stateDirectory,
      runId,
      git,
      artifacts,
    ).create({
      phaseId: phase.id,
      beforeCommit: release.sourceCommit,
      gateDecision: "satisfied",
      handoff,
    });
    await this.append(project.projectId, runId, {
      type: "checkpoint.recorded",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: { checkpoint },
    });
    await this.append(project.projectId, runId, {
      type: "phase.transitioned",
      actor,
      context: { phaseId: phase.id },
      data: { phaseId: phase.id, from: "running", to: "completed" },
    });
    await this.append(project.projectId, runId, {
      type: "attempt.completed",
      actor,
      context: { phaseId: phase.id, attemptId },
      data: { attemptId, status: "completed" },
    });
    return "completed";
  }

  private async enterWorkflow(
    command: Extract<
      ServiceCommand,
      { type: "new" | "run" | "next" | "phase-run" }
    >,
  ): Promise<unknown> {
    if (!this.acceptingWork)
      throw new Error("SWF service is draining and cannot start new work");
    const project = await this.project(command.projectId);
    const location = await findProjectRoot(project.root);
    if (!location?.initialized)
      throw new Error("Workflow entry requires an initialized project");
    const config = await readProjectConfig(location);
    const store = new RunEventStore(project.stateDirectory, {
      redaction: this.redactor,
    });
    const changeIdentity = `openspec/changes/${command.changeName}`;
    const existingRunId = await store.findRunByChangeIdentity(changeIdentity);
    if (existingRunId) {
      if (command.type === "new")
        throw new Error(
          `OpenSpec change ${command.changeName} is already bound to run ${existingRunId}; use swf run, swf next, or status`,
        );
      let existing = await store.load(existingRunId);
      if (
        command.description &&
        command.description.trim() !== existing.state.run.description
      )
        throw new Error(
          `Description conflicts with the recorded Planning input for run ${existingRunId}; use an explicit revision flow`,
        );
      if (existing.state.run.status === "completed")
        return {
          runId: existingRunId,
          changeName: command.changeName,
          status: "completed",
          idempotent: true,
        };
      if (
        existing.state.run.status === "running" ||
        this.activeWork.has(existingRunId)
      )
        throw new Error(`Run ${existingRunId} already has active work`);
      if (existing.state.run.status === "blocked")
        throw new Error(
          `Run ${existingRunId} is blocked; satisfy its gate or operator input before resuming`,
        );
      for (const phase of Object.values(existing.state.phases).filter(
        ({ status }) => status === "running",
      )) {
        const attemptId = phase.attemptIds.at(-1);
        if (
          attemptId &&
          existing.state.attempts[attemptId]?.status === "running"
        )
          await this.append(project.projectId, existingRunId, {
            type: "attempt.completed",
            actor: { type: "service", id: "swf-scheduler" },
            context: { phaseId: phase.id, attemptId },
            data: {
              attemptId,
              status: "failed",
              reason: "Recovered interrupted phase before resume",
            },
          });
        await this.append(project.projectId, existingRunId, {
          type: "phase.transitioned",
          actor: { type: "service", id: "swf-scheduler" },
          context: { phaseId: phase.id },
          data: {
            phaseId: phase.id,
            from: "running",
            to: "failed",
            reason: "Recovered interrupted phase before resume",
          },
        });
      }
      existing = await store.load(existingRunId);
      const settings = await loadProjectExecutionSettings(
        location,
        existing.state.run.workflowId,
        existing.state.run.policyId ?? "manual",
      );
      await this.preflightDelivery(project.projectId, existingRunId);
      const runtime = await new RunRuntime(
        new GitClient(project.root, this.commandRunner),
        this.herdr,
        new RuntimeOwnershipStore(project.stateDirectory),
      ).prepare({
        runId: existingRunId,
        stateDirectory: project.stateDirectory,
      });
      const incomplete = settings.workflow.phases.filter(
        ({ id }) => existing.state.phases[id]?.status !== "completed",
      );
      const selected =
        command.type === "phase-run"
          ? settings.workflow.phases.filter(({ id }) => id === command.phaseId)
          : command.type === "next"
            ? incomplete.slice(0, 1)
            : incomplete;
      if (command.type === "phase-run" && selected.length === 0)
        throw new Error(`Unknown phase: ${command.phaseId ?? "(missing)"}`);
      if (
        command.type === "phase-run" &&
        command.phaseId &&
        existing.state.phases[command.phaseId]?.status === "completed"
      )
        throw new Error(
          `Phase ${command.phaseId} is already completed; use an explicit rerun`,
        );
      if (selected.length === 0)
        throw new Error(
          `Run ${existingRunId} has no eligible incomplete phase`,
        );
      await this.append(project.projectId, existingRunId, {
        type: "run.transitioned",
        actor: { type: "service", id: "swf-scheduler" },
        context: {},
        data: {
          from: existing.state.run.status,
          to: "running",
          reason: command.type,
        },
      });
      let lastStatus: "completed" | "blocked" | "failed" = "completed";
      try {
        for (const phase of selected) {
          let attempts = 0;
          do {
            attempts += 1;
            lastStatus = await this.executePhase({
              project,
              runId: existingRunId,
              phaseId: phase.id,
              settings,
              runtime,
            });
          } while (
            lastStatus === "failed" &&
            attempts < settings.policy.maxAttempts
          );
          if (lastStatus !== "completed") break;
        }
      } catch (error) {
        const interrupted = await store.load(existingRunId);
        if (interrupted.state.run.status === "running")
          await this.append(project.projectId, existingRunId, {
            type: "run.transitioned",
            actor: { type: "service", id: "swf-scheduler" },
            context: {},
            data: {
              from: "running",
              to: "paused",
              reason: `phase did not start: ${error instanceof Error ? error.message : "eligibility failure"}`,
            },
          });
        throw error;
      }
      const after = await store.load(existingRunId);
      const target =
        lastStatus === "blocked"
          ? "blocked"
          : lastStatus === "failed"
            ? "failed"
            : Object.values(after.state.phases).every(
                  ({ status }) => status === "completed",
                )
              ? "completed"
              : "paused";
      if (target === "completed")
        await this.persistRunDossier(project.projectId, existingRunId);
      await this.append(project.projectId, existingRunId, {
        type: "run.transitioned",
        actor: { type: "service", id: "swf-scheduler" },
        context: {},
        data: {
          from: "running",
          to: target,
          reason: `${command.type} progression stopped`,
        },
      });
      return {
        runId: existingRunId,
        changeName: command.changeName,
        phaseId:
          selected.find(
            ({ id }) => after.state.phases[id]?.status !== "completed",
          )?.id ?? selected.at(-1)?.id,
        status: target,
      };
    }
    if (command.type === "next" || command.type === "phase-run")
      throw new Error(
        `No run is bound to ${command.changeName}; start it with swf new or swf run`,
      );
    if (command.fromExplorationId && command.description?.trim())
      throw new Error(
        "Choose either --description or --from-exploration, not both",
      );
    const exploration = command.fromExplorationId
      ? await new ExplorationStore(project.stateDirectory).promote(
          command.fromExplorationId,
        )
      : undefined;
    const description = command.description?.trim() ?? exploration?.problem;
    if (!description)
      throw new Error(
        "A non-empty --description or explicit --from-exploration is required for a new change",
      );
    const prepared = await this.prepareRun({
      project,
      changeName: command.changeName,
      description,
      workflowId: command.workflowId ?? config.defaultWorkflow,
      policyId: command.policyId,
      authorization: command.authorization,
    });
    await writeAtomically(
      join(
        project.stateDirectory,
        "runs",
        prepared.run.runId,
        "planning-input.json",
      ),
      `${JSON.stringify(
        exploration
          ? {
              kind: "exploration",
              explorationId: exploration.explorationId,
              brief: exploration,
            }
          : { kind: "description", description },
        null,
        2,
      )}\n`,
    );
    await this.append(project.projectId, prepared.run.runId, {
      type: "run.transitioned",
      actor: { type: "service", id: "swf-scheduler" },
      context: {},
      data: { from: "pending", to: "running", reason: command.type },
    });
    const phaseIds = prepared.settings.workflow.phases.map(({ id }) => id);
    const selected = command.type === "new" ? phaseIds.slice(0, 1) : phaseIds;
    let lastStatus: "completed" | "blocked" | "failed" = "completed";
    try {
      for (const phaseId of selected) {
        let attempts = 0;
        do {
          attempts += 1;
          lastStatus = await this.executePhase({
            project,
            runId: prepared.run.runId,
            phaseId,
            settings: prepared.settings,
            runtime: prepared.runtime,
          });
        } while (
          lastStatus === "failed" &&
          attempts < prepared.settings.policy.maxAttempts
        );
        if (lastStatus !== "completed") break;
      }
    } catch (error) {
      const interrupted = await store.load(prepared.run.runId);
      if (interrupted.state.run.status === "running")
        await this.append(project.projectId, prepared.run.runId, {
          type: "run.transitioned",
          actor: { type: "service", id: "swf-scheduler" },
          context: {},
          data: {
            from: "running",
            to: "failed",
            reason:
              error instanceof Error ? error.message : "phase startup failed",
          },
        });
      throw error;
    }
    const loaded = await store.load(prepared.run.runId);
    const target =
      lastStatus === "blocked"
        ? "blocked"
        : lastStatus === "failed"
          ? "failed"
          : command.type === "new"
            ? "paused"
            : Object.values(loaded.state.phases).every(
                  ({ status }) => status === "completed",
                )
              ? "completed"
              : "paused";
    if (target === "completed")
      await this.persistRunDossier(project.projectId, prepared.run.runId);
    await this.append(project.projectId, prepared.run.runId, {
      type: "run.transitioned",
      actor: { type: "service", id: "swf-scheduler" },
      context: {},
      data: {
        from: "running",
        to: target,
        reason: `${command.type} progression stopped`,
      },
    });
    return {
      runId: prepared.run.runId,
      changeName: command.changeName,
      phaseId:
        selected.at(
          Math.max(
            0,
            selected.findIndex(
              (id) => loaded.state.phases[id]?.status !== "completed",
            ),
          ),
        ) ?? selected.at(-1),
      status: target,
    };
  }

  private async persistRunDossier(
    projectId: string,
    runId: string,
  ): Promise<void> {
    const { project, store } = await this.runStore(projectId);
    const loaded = await store.load(runId);
    const runtime = await readJson<{ worktreePath?: string }>(
      join(project.stateDirectory, "runs", runId, "runtime.json"),
    );
    if (!runtime?.worktreePath) return;
    const artifacts = new ArtifactStore(
      project.stateDirectory,
      runId,
      this.redactor,
    );
    const handoffs = (
      await Promise.all(
        (await artifacts.load()).artifacts
          .filter(({ type }) => type === "phase-handoff")
          .map(({ outputRef }) =>
            readJson(join(project.stateDirectory, "runs", runId, outputRef)),
          ),
      )
    ).filter(
      (value): value is NonNullable<typeof value> => value !== undefined,
    );
    let approvals: unknown[] = [];
    try {
      approvals = await Promise.all(
        (
          await readdir(
            join(project.stateDirectory, "runs", runId, "approvals"),
          )
        )
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) =>
            readJson(
              join(project.stateDirectory, "runs", runId, "approvals", entry),
            ),
          ),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const planningInput = await readJson<{
      kind?: string;
      brief?: {
        explorationId: string;
        problem: string;
        goals: string[];
        decisions: string[];
        openQuestions: string[];
        candidateScope: string;
        candidateChangeName: string;
      };
    }>(join(project.stateDirectory, "runs", runId, "planning-input.json"));
    await persistChangeDossier({
      changeRoot: join(
        runtime.worktreePath,
        "openspec",
        "changes",
        loaded.state.run.changeName,
      ),
      runId,
      artifacts,
      handoffs: handoffs as never,
      approvals: approvals.filter(Boolean) as never,
      checkpoints: Object.values(loaded.state.checkpoints),
      deliveries: Object.values(loaded.state.deliveries),
      invocations: Object.values(loaded.state.invocations),
      explorationFoundation:
        planningInput?.kind === "exploration" ? planningInput.brief : undefined,
      finalReport: `SWF run ${runId} completed ${loaded.state.run.phaseIds?.length ?? 0} phases for ${loaded.state.run.changeName}.`,
    });
    try {
      await new GitClient(runtime.worktreePath, this.commandRunner).commit(
        "swf: persist portable evidence dossier",
      );
    } catch (error) {
      // Hosting-only integrations may persist their dossier into a synthetic
      // worktree without a usable Git repository. The dossier is already
      // durable on disk; do not prevent delivery cleanup or monitoring from
      // completing because that optional commit cannot be created.
      if (
        !(error instanceof GitCommandError) ||
        !error.message.includes("not a git repository")
      )
        throw error;
    }
  }

  private async append<T extends EventType>(
    projectId: string,
    runId: string,
    draft: EventDraft<T>,
  ): Promise<void> {
    const { store } = await this.runStore(projectId);
    const loaded = await store.load(runId);
    const candidate = createRunEvent({
      ...draft,
      runId,
      sequence: loaded.state.lastSequence + 1,
    });
    reduceRunState(loaded.state, candidate);
    const result = await store.append(runId, draft);
    if (result.appended) {
      this.broker.publish({
        type: result.event.type,
        projectId,
        runId,
        data: { event: result.event },
      });
      if (
        result.event.type === "run.transitioned" &&
        result.event.data.to === "completed"
      ) {
        void this.persistRunDossier(projectId, runId).catch((error) => {
          this.broker.publish({
            type: "dossier.write-error",
            projectId,
            runId,
            data: {
              message:
                error instanceof Error
                  ? error.message
                  : "portable dossier generation failed",
            },
          });
        });
        void this.deliver(projectId, runId).catch((error) => {
          this.broker.publish({
            type: "delivery.start-error",
            projectId,
            runId,
            data: {
              message:
                error instanceof Error
                  ? error.message
                  : "delivery start failed",
            },
          });
        });
      }
    }
  }

  private async commandRunId(
    command: ServiceCommand,
    result?: unknown,
  ): Promise<string | undefined> {
    const projectId = "projectId" in command ? command.projectId : undefined;
    const runId =
      ("runId" in command ? command.runId : undefined) ??
      (result && typeof result === "object" && "runId" in result
        ? String(result.runId)
        : undefined);
    if (runId || !projectId || !("changeName" in command)) return runId;
    const { store } = await this.runStore(projectId);
    return store.findRunByChangeIdentity(
      `openspec/changes/${command.changeName}`,
    );
  }

  async command(command: ServiceCommand): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.commandUnredacted(command);
    } catch (error) {
      const projectId = "projectId" in command ? command.projectId : undefined;
      const runId = await this.commandRunId(command).catch(() => undefined);
      const projection =
        projectId && runId
          ? await this.operatorProjection(projectId, runId).catch(
              () => undefined,
            )
          : undefined;
      throw new OperatorCommandError(
        classifyOperatorError({
          error,
          recoveryActions: projection?.allowedActions ?? [],
        }),
        projection,
      );
    }
    // The mutation already succeeded: never let projection failures report it as failed.
    const projectId = "projectId" in command ? command.projectId : undefined;
    const runId = await this.commandRunId(command, result).catch(
      () => undefined,
    );
    const projection =
      projectId && runId
        ? await this.operatorProjection(projectId, runId).catch(() => undefined)
        : undefined;
    if (!projection) return this.redactor.value(result);
    const compatible =
      result && typeof result === "object" && !Array.isArray(result)
        ? result
        : result === undefined
          ? {}
          : { value: result };
    return this.redactor.value({ ...compatible, projection });
  }

  private async commandUnredacted(command: ServiceCommand): Promise<unknown> {
    this.requireRunning();
    if (command.childContext?.childMode && !command.childContext.allowNested)
      throw new Error(
        "Child phase invocations cannot mutate SWF orchestration without explicit nested-execution permission",
      );
    await this.audit.append({
      operation: `command.${command.type}`,
      actor: {
        type:
          "actorId" in command && typeof command.actorId === "string"
            ? "user"
            : "service-client",
        id:
          "actorId" in command && typeof command.actorId === "string"
            ? command.actorId
            : "authenticated-client",
      },
      projectId: "projectId" in command ? command.projectId : undefined,
      runId: "runId" in command ? command.runId : undefined,
      outcome: "accepted",
      details: { type: command.type },
    });
    if (
      command.type === "new" ||
      command.type === "run" ||
      command.type === "next" ||
      command.type === "phase-run"
    )
      return this.enterWorkflow(command);
    if (
      command.type === "model-map-preview" ||
      command.type === "model-map-apply" ||
      command.type === "checks-preview" ||
      command.type === "checks-apply"
    ) {
      const project = await this.project(command.projectId);
      if (
        command.type === "model-map-preview" ||
        command.type === "model-map-apply"
      ) {
        if (!command.tier || !command.harness || !command.model)
          throw new Error(
            "tier, harness, and model are required for model mapping",
          );
        if (command.type === "model-map-preview")
          return previewModelMapping({
            tier: command.tier,
            harness: command.harness,
            model: command.model,
          });
        return applyModelMapping({
          root: project.root,
          tier: command.tier,
          harness: command.harness,
          model: command.model,
          confirmed: Boolean(command.confirmed),
        });
      }
      const discovery = await discoverProjectChecks(project.root);
      if (command.type === "checks-preview")
        return previewCheckAdoption(
          discovery.candidates,
          command.selectedIds ?? [],
        );
      return applyCheckAdoption({
        root: project.root,
        candidates: discovery.candidates,
        selectedIds: command.selectedIds ?? [],
        confirmed: Boolean(command.confirmed),
      });
    }
    if (command.type === "archive-change") {
      if (!command.authorized)
        throw new Error("OpenSpec archive requires explicit authorization");
      const project = await this.project(command.projectId);
      const store = new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      });
      const loaded = await store.load(command.runId);
      const deliveries = Object.values(loaded.state.deliveries);
      if (
        !deliveries.some(
          ({ status }) => status === "merged" || status === "local-branch",
        )
      )
        throw new Error(
          "OpenSpec archive requires a successful recorded delivery",
        );
      const runtime = await readJson<{ worktreePath?: string }>(
        join(project.stateDirectory, "runs", command.runId, "runtime.json"),
      );
      const cwd = runtime?.worktreePath ?? project.root;
      const result = await this.commandRunner.run(
        "openspec",
        ["archive", "change", loaded.state.run.changeName],
        { cwd },
      );
      if (result.code !== 0)
        throw new Error(
          `OpenSpec archive failed: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      return {
        archived: loaded.state.run.changeName,
        output: `${result.stdout}${result.stderr}`.trim(),
      };
    }
    if (command.type === "defaults-adopt") {
      if (!command.confirmed)
        throw new Error("Defaults adoption requires explicit confirmation");
      const project = await this.project(command.projectId);
      const location = await findProjectRoot(project.root);
      if (!location?.initialized) throw new Error("Project is not initialized");
      const metadata = await readTemplateMetadata(location.configDirectory);
      if (!metadata)
        throw new Error(
          "This project has no template metadata; inspect and reconcile legacy defaults before adoption",
        );
      const projectConfig = await readProjectConfig(location);
      const installed = defaultTemplateFiles(projectConfig.projectId);
      const diff = await inspectTemplateDiff({
        configDirectory: location.configDirectory,
        adopted: metadata,
        installed,
      });
      const selectedPaths = command.selectedPaths ?? [];
      const backupDirectory = join(
        project.stateDirectory,
        "template-backups",
        randomUUID(),
      );
      return adoptTemplateFiles({
        configDirectory: location.configDirectory,
        metadata,
        installed,
        selectedPaths,
        diff,
        backupDirectory,
      });
    }
    if (command.type === "blocked-input") {
      await this.submitBlockedInput(command.invocationId, command.response);
      return;
    }
    if (command.type === "explore-start") {
      const project = await this.project(command.projectId);
      const store = new ExplorationStore(project.stateDirectory);
      const exploration = await store.start(command.idea);
      const git = new GitClient(project.root, this.commandRunner);
      const before = await git.status();
      const files = await this.commandRunner.run("git", ["ls-files"], {
        cwd: project.root,
      });
      const after = await git.status();
      if (JSON.stringify(before.files) !== JSON.stringify(after.files))
        throw new Error("Read-only exploration changed repository state");
      const candidateChangeName =
        command.candidateChangeName ??
        (command.idea
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60) ||
          "explored-change");
      await store.appendTranscript(
        exploration.explorationId,
        `Read-only repository inspection:\n${files.stdout}`,
      );
      const question =
        "What constraints or non-goals should Planning preserve?";
      await store.event(exploration.explorationId, "question", { question });
      const brief = await store.recordBrief({
        explorationId: exploration.explorationId,
        problem: command.idea.trim(),
        goals: [command.idea.trim()],
        nonGoals: [],
        options: [],
        decisions: [],
        openQuestions: [question],
        codebaseFindings: files.stdout
          .split("\n")
          .filter(Boolean)
          .slice(0, 100),
        candidateScope: "Refine during Planning",
        candidateChangeName,
      });
      return { exploration: await store.get(exploration.explorationId), brief };
    }
    if (
      command.type === "explore-resume" ||
      command.type === "explore-cancel" ||
      command.type === "explore-discard" ||
      command.type === "explore-promote" ||
      command.type === "explore-answer"
    ) {
      const project = await this.project(command.projectId);
      const store = new ExplorationStore(project.stateDirectory);
      if (command.type === "explore-resume")
        return store.resume(command.explorationId);
      if (command.type === "explore-cancel")
        return store.cancel(command.explorationId);
      if (command.type === "explore-discard")
        return store.discard(command.explorationId);
      if (command.type === "explore-answer") {
        await store.answer(command.explorationId, command.answer ?? "");
        return store.get(command.explorationId);
      }
      return store.promote(command.explorationId);
    }
    if (
      command.type === "phase-rerun" ||
      command.type === "phase-skip" ||
      command.type === "check-run"
    ) {
      const project = await this.project(command.projectId);
      const location = await findProjectRoot(project.root);
      if (!location?.initialized) throw new Error("Project is not initialized");
      const store = new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      });
      const runId = await store.findRunByChangeIdentity(
        `openspec/changes/${command.changeName}`,
      );
      if (!runId) throw new Error(`No run is bound to ${command.changeName}`);
      const loaded = await store.load(runId);
      const settings = await loadProjectExecutionSettings(
        location,
        loaded.state.run.workflowId,
        loaded.state.run.policyId ?? "manual",
      );
      if (command.type === "phase-rerun") {
        if (!command.phaseId) throw new Error("phaseId is required for rerun");
        const preview = previewPhaseRerun(
          settings.workflow,
          loaded.state,
          command.phaseId,
        );
        if (!command.authorized)
          return { preview, requiresAuthorization: true };
        await new ArtifactStore(
          project.stateDirectory,
          runId,
          this.redactor,
        ).invalidateForRunMutation({
          kind: "reset",
          artifactIds: preview.invalidatedArtifactIds,
        });
        for (const phaseId of preview.invalidatedPhaseIds) {
          const status = loaded.state.phases[phaseId]?.status;
          if (status === "completed")
            await this.append(project.projectId, runId, {
              type: "phase.transitioned",
              actor: { type: "user", id: "operator" },
              context: { phaseId },
              data: {
                phaseId,
                from: "completed",
                to: "pending",
                reason: "authorized rerun invalidation",
              },
            });
        }
        for (const delivery of Object.values(loaded.state.deliveries))
          await this.append(project.projectId, runId, {
            type: "delivery.recorded",
            actor: { type: "user", id: "operator" },
            context: {},
            data: { delivery: { ...delivery, status: "pending" } },
          });
        if (loaded.state.run.status === "completed")
          await this.append(project.projectId, runId, {
            type: "run.transitioned",
            actor: { type: "user", id: "operator" },
            context: {},
            data: {
              from: "completed",
              to: "pending",
              reason: "authorized phase rerun",
            },
          });
        const attemptId = randomUUID();
        await this.append(project.projectId, runId, {
          type: "attempt.started",
          actor: { type: "user", id: "operator" },
          context: { phaseId: command.phaseId, attemptId },
          data: {
            attemptId,
            phaseId: command.phaseId,
            number:
              (loaded.state.phases[command.phaseId]?.attemptIds.length ?? 0) +
              1,
            kind: "rerun",
          },
        });
        await this.append(project.projectId, runId, {
          type: "phase.rerun",
          actor: { type: "user", id: "operator" },
          context: { phaseId: command.phaseId, attemptId },
          data: {
            phaseId: command.phaseId,
            attemptId,
            reason: "authorized rerun",
          },
        });
        await this.append(project.projectId, runId, {
          type: "attempt.completed",
          actor: { type: "service", id: "swf-scheduler" },
          context: { phaseId: command.phaseId, attemptId },
          data: {
            attemptId,
            status: "completed",
            reason: "rerun invalidation applied",
          },
        });
        return this.enterWorkflow({
          type: "phase-run",
          projectId: command.projectId,
          changeName: command.changeName,
          phaseId: command.phaseId,
        });
      }
      if (command.type === "phase-skip") {
        if (!command.authorized)
          throw new Error("Phase skip requires explicit authorization");
        if (!command.phaseId) throw new Error("phaseId is required for skip");
        const status = loaded.state.phases[command.phaseId]?.status;
        if (!status) throw new Error(`Unknown phase: ${command.phaseId}`);
        await this.append(project.projectId, runId, {
          type: "phase.transitioned",
          actor: { type: "user", id: "operator" },
          context: { phaseId: command.phaseId },
          data: {
            phaseId: command.phaseId,
            from: status,
            to: "skipped",
            reason: "authorized skip",
          },
        });
        return { runId, phaseId: command.phaseId, status: "skipped" };
      }
      if (!command.checkId) throw new Error("checkId is required");
      const phase = settings.workflow.phases.find(({ checks }) =>
        checks.some(({ id }) => id === command.checkId),
      );
      const check = phase?.checks.find(({ id }) => id === command.checkId);
      if (!phase || !check)
        throw new Error(`Unknown declared check: ${command.checkId}`);
      const runtime = await readJson<{ worktreePath?: string }>(
        join(project.stateDirectory, "runs", runId, "runtime.json"),
      );
      if (!runtime?.worktreePath)
        throw new Error(`Run ${runId} has no recorded worktree`);
      const artifacts = new ArtifactStore(
        project.stateDirectory,
        runId,
        this.redactor,
      );
      const commit = await new GitClient(
        runtime.worktreePath,
        this.commandRunner,
      ).head();
      const evidence =
        check.type === "command" && check.command
          ? await runCommandCheck({
              runner: this.commandRunner,
              artifacts,
              request: {
                checkId: check.id,
                phaseId: phase.id,
                command: "/bin/sh",
                args: ["-lc", check.command],
                configuration: check.options,
                commit,
                cwd: runtime.worktreePath,
              },
            })
          : check.type === "openspec"
            ? await runOpenSpecCheck({
                runner: this.commandRunner,
                artifacts,
                checkId: check.id,
                phaseId: phase.id,
                changeName: loaded.state.run.changeName,
                commit,
                cwd: runtime.worktreePath,
              })
            : undefined;
      if (!evidence?.artifact)
        throw new Error(
          `Check ${check.id} requires its ${check.type} executor`,
        );
      await this.append(project.projectId, runId, {
        type: "artifact.recorded",
        actor: { type: "service", id: "swf-check-runner" },
        context: { phaseId: phase.id, checkId: check.id },
        data: { artifact: evidence.artifact },
      });
      await this.append(project.projectId, runId, {
        type: "check.recorded",
        actor: { type: "service", id: "swf-check-runner" },
        context: { phaseId: phase.id, checkId: check.id },
        data: {
          checkId: check.id,
          phaseId: phase.id,
          status: evidence.status,
          artifactId: evidence.artifact.artifactId,
          reason: evidence.summary,
        },
      });
      return evidence;
    }
    if (command.type === "deliver" || command.type === "refresh-delivery") {
      await this.deliver(command.projectId, command.runId, {
        refreshOnly: command.type === "refresh-delivery",
      });
      return;
    }
    if (command.type === "reconcile") {
      const project = await this.project(command.projectId);
      const report = await inspectOperationalHealth(
        project.stateDirectory,
        command.staleAfterMs ?? this.stuckAfterMs,
      );
      const actions: Array<Record<string, unknown>> = [];
      if (command.apply) {
        const store = new RunEventStore(project.stateDirectory, {
          redaction: this.redactor,
        });
        for (const stuck of report.stuck) {
          const state = (await store.load(stuck.runId)).state;
          if (state.run.status === "running") {
            await this.append(project.projectId, stuck.runId, {
              type: "run.transitioned",
              actor: { type: "service", id: "swf-reconciler" },
              context: { phaseId: stuck.phaseId },
              data: {
                from: "running",
                to: "blocked",
                reason: `stuck invocation ${stuck.invocationId}`,
              },
            });
            actions.push({ action: "blocked", runId: stuck.runId });
          }
        }
        for (const orphan of report.orphans) {
          const runtime = new RunRuntime(
            new GitClient(project.root),
            new HerdrClient(),
            new RuntimeOwnershipStore(project.stateDirectory),
          );
          try {
            const cleaned = await runtime.cleanup(orphan.runId);
            actions.push({
              action: "cleaned-owned-resources",
              runId: orphan.runId,
              resources: cleaned,
            });
          } catch (error) {
            actions.push({
              action: "cleanup-failed",
              runId: orphan.runId,
              error: error instanceof Error ? error.message : "cleanup failed",
            });
          }
        }
      }
      await this.audit.append({
        operation: "operations.reconcile",
        actor: { type: "user", id: "operator" },
        projectId: project.projectId,
        outcome: "completed",
        details: { apply: Boolean(command.apply), actions },
      });
      return { report, applied: Boolean(command.apply), actions };
    }
    if (command.type === "migrate") {
      const project = await this.project(command.projectId);
      const manager = new StateMigrationManager(project.stateDirectory);
      const result = command.rollbackBackupId
        ? await manager
            .rollback(command.rollbackBackupId)
            .then(() => ({ rolledBack: command.rollbackBackupId }))
        : await manager.migrate({
            target: command.target,
            dryRun: command.dryRun ?? true,
          });
      await this.audit.append({
        operation: command.rollbackBackupId
          ? "state.rollback-migration"
          : "state.migrate",
        actor: { type: "user", id: "operator" },
        projectId: project.projectId,
        outcome: "completed",
        details: { result },
      });
      return result;
    }
    if (command.type === "export-run") {
      const project = await this.project(command.projectId);
      const result = await exportRun(
        project.stateDirectory,
        command.runId,
        command.path,
      );
      await this.audit.append({
        operation: "run.export",
        actor: { type: "user", id: "operator" },
        projectId: project.projectId,
        runId: command.runId,
        outcome: "completed",
        details: { path: command.path, files: result.files.length },
      });
      return {
        runId: result.runId,
        path: command.path,
        files: result.files.length,
      };
    }
    if (command.type === "import-run") {
      const project = await this.project(command.projectId);
      const result = await importRun(project.stateDirectory, command.path);
      await this.audit.append({
        operation: "run.import",
        actor: { type: "user", id: "operator" },
        projectId: project.projectId,
        runId: result.runId,
        outcome: "completed",
        details: { path: command.path, files: result.files },
      });
      return result;
    }
    if (!this.acceptingWork && command.type === "start")
      throw new Error("SWF service is draining and cannot start new work");
    if (!("runId" in command))
      throw new Error(`Unsupported workflow entry command: ${command.type}`);
    const { store } = await this.runStore(command.projectId);
    const loaded = await store.load(command.runId);
    if (command.type === "start") {
      assertBudgetsAvailable(
        await this.budgetReport(
          command.projectId,
          command.runId,
          command.phaseId,
        ),
      );
      await this.preflightDelivery(command.projectId, command.runId);
    }
    const actor = { type: "service" as const, id: "swf-service" };
    if (
      command.type === "start" ||
      command.type === "pause" ||
      command.type === "resume" ||
      command.type === "cancel"
    ) {
      if (command.type === "cancel")
        await this.activeWork.get(command.runId)?.interrupt();
      const target =
        command.type === "pause"
          ? "paused"
          : command.type === "cancel"
            ? "cancelled"
            : "running";
      await this.append(command.projectId, command.runId, {
        type: "run.transitioned",
        actor,
        context: {},
        data: {
          from: loaded.state.run.status,
          to: target,
          reason: command.type,
        },
      });
      return;
    }
    if (
      command.type === "approve" ||
      command.type === "reject" ||
      command.type === "request-changes"
    ) {
      const decision =
        command.type === "approve"
          ? "approved"
          : command.type === "reject"
            ? "rejected"
            : "request-changes";
      const approval = recordHumanApproval({
        runId: command.runId,
        phaseId: command.phaseId,
        actor: { type: "user", id: command.actorId },
        decision,
        reason: command.reason,
        evidenceArtifactIds: command.evidenceArtifactIds,
      });
      await writeAtomically(
        join(
          (await this.project(command.projectId)).stateDirectory,
          "runs",
          command.runId,
          "approvals",
          `${approval.approvalId}.json`,
        ),
        `${JSON.stringify(approval, null, 2)}\n`,
      );
      await this.append(command.projectId, command.runId, {
        type: "gate.decided",
        actor: { type: "user", id: command.actorId },
        context: { phaseId: command.phaseId },
        data: {
          gateId: command.gateId,
          phaseId: command.phaseId,
          status: command.type === "approve" ? "satisfied" : "rejected",
          reason:
            command.reason ??
            (command.type === "request-changes"
              ? "Operator requested changes"
              : undefined),
        },
      });
      if (
        command.type === "approve" &&
        loaded.state.run.status === "blocked" &&
        loaded.state.phases[command.phaseId]?.status === "blocked"
      ) {
        const project = await this.project(command.projectId);
        const runtime = await readJson<{ worktreePath?: string }>(
          join(project.stateDirectory, "runs", command.runId, "runtime.json"),
        );
        if (!runtime?.worktreePath)
          throw new Error(`Run ${command.runId} has no recorded worktree`);
        const artifacts = new ArtifactStore(
          project.stateDirectory,
          command.runId,
          this.redactor,
        );
        const manifest = await artifacts.load();
        const handoffArtifact = [...manifest.artifacts]
          .reverse()
          .find(
            ({ phaseId, type }) =>
              phaseId === command.phaseId && type === "phase-handoff",
          );
        const handoff = handoffArtifact
          ? await readJson(
              join(
                project.stateDirectory,
                "runs",
                command.runId,
                handoffArtifact.outputRef,
              ),
            )
          : undefined;
        const git = new GitClient(runtime.worktreePath, this.commandRunner);
        const beforeCommit = await git.head();
        await this.append(command.projectId, command.runId, {
          type: "run.transitioned",
          actor: { type: "user", id: command.actorId },
          context: { phaseId: command.phaseId },
          data: {
            from: "blocked",
            to: "running",
            reason: "manual gate approved",
          },
        });
        await this.append(command.projectId, command.runId, {
          type: "phase.transitioned",
          actor: { type: "user", id: command.actorId },
          context: { phaseId: command.phaseId },
          data: {
            phaseId: command.phaseId,
            from: "blocked",
            to: "running",
            reason: "manual gate approved",
          },
        });
        const checkpoint = await new CheckpointManager(
          project.stateDirectory,
          command.runId,
          git,
          artifacts,
        ).create({
          phaseId: command.phaseId,
          beforeCommit,
          gateDecision: "satisfied",
          handoff: handoff as never,
        });
        await this.append(command.projectId, command.runId, {
          type: "checkpoint.recorded",
          actor: { type: "service", id: "swf-scheduler" },
          context: { phaseId: command.phaseId },
          data: { checkpoint },
        });
        await this.append(command.projectId, command.runId, {
          type: "phase.transitioned",
          actor: { type: "service", id: "swf-scheduler" },
          context: { phaseId: command.phaseId },
          data: {
            phaseId: command.phaseId,
            from: "running",
            to: "completed",
          },
        });
        const priorAttemptId =
          loaded.state.phases[command.phaseId]?.attemptIds.at(-1);
        if (priorAttemptId)
          await this.append(command.projectId, command.runId, {
            type: "attempt.completed",
            actor: { type: "service", id: "swf-scheduler" },
            context: {
              phaseId: command.phaseId,
              attemptId: priorAttemptId,
            },
            data: {
              attemptId: priorAttemptId,
              status: "completed",
              reason: "Manual gate approved",
            },
          });
        await this.append(command.projectId, command.runId, {
          type: "run.transitioned",
          actor: { type: "service", id: "swf-scheduler" },
          context: {},
          data: {
            from: "running",
            to: "paused",
            reason: "manual approval finalized phase",
          },
        });
      }
      if (command.type === "request-changes") {
        const attemptId = randomUUID();
        const number =
          (loaded.state.phases[command.phaseId]?.attemptIds.length ?? 0) + 1;
        await this.append(command.projectId, command.runId, {
          type: "attempt.started",
          actor: { type: "user", id: command.actorId },
          context: { phaseId: command.phaseId, attemptId },
          data: {
            attemptId,
            phaseId: command.phaseId,
            number,
            kind: "remediation",
          },
        });
        await this.append(command.projectId, command.runId, {
          type: "run.remediated",
          actor: { type: "user", id: command.actorId },
          context: { phaseId: command.phaseId, attemptId },
          data: {
            phaseId: command.phaseId,
            attemptId,
            reason: command.reason ?? "Operator requested changes",
          },
        });
      }
      return { approval };
    }
    if (command.type === "rollback") {
      if (command.authorized !== true)
        throw new Error("Rollback requires explicit authorization");
      const project = await this.project(command.projectId);
      const runtime = await readJson<{ worktreePath?: string }>(
        join(project.stateDirectory, "runs", command.runId, "runtime.json"),
      );
      if (!runtime?.worktreePath)
        throw new Error(`Run ${command.runId} has no recorded worktree`);
      const artifacts = new ArtifactStore(
        project.stateDirectory,
        command.runId,
        this.redactor,
      );
      await new CheckpointManager(
        project.stateDirectory,
        command.runId,
        new GitClient(runtime.worktreePath, this.commandRunner),
        artifacts,
      ).rollback({
        checkpointId: command.checkpointId,
        phaseId: command.phaseId,
        invalidatedPhaseIds: command.invalidatedPhaseIds ?? [],
        invalidatedArtifactIds: command.invalidatedArtifactIds ?? [],
        authorized: true,
      });
      const attemptId = randomUUID();
      const number =
        (loaded.state.phases[command.phaseId]?.attemptIds.length ?? 0) + 1;
      await this.append(command.projectId, command.runId, {
        type: "attempt.started",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: {
          attemptId,
          phaseId: command.phaseId,
          number,
          kind: "rollback",
        },
      });
      await this.append(command.projectId, command.runId, {
        type: "run.rolled-back",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: {
          checkpointId: command.checkpointId,
          phaseId: command.phaseId,
          attemptId,
          invalidatedPhaseIds: command.invalidatedPhaseIds ?? [],
        },
      });
      await this.append(command.projectId, command.runId, {
        type: "attempt.completed",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: {
          attemptId,
          status: "completed",
          reason: "Rollback completed",
        },
      });
      return;
    }
    if (command.type === "remediate") {
      const attemptId = randomUUID();
      const number =
        (loaded.state.phases[command.phaseId]?.attemptIds.length ?? 0) + 1;
      await this.append(command.projectId, command.runId, {
        type: "attempt.started",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: {
          attemptId,
          phaseId: command.phaseId,
          number,
          kind: "remediation",
        },
      });
      await this.append(command.projectId, command.runId, {
        type: "run.remediated",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: { phaseId: command.phaseId, attemptId, reason: command.reason },
      });
    }
  }

  async shutdown(options: { force?: boolean } = {}): Promise<void> {
    if (!this.metadata) return;
    this.acceptingWork = false;
    const force = options.force ?? false;
    this.broker.publish({
      type: force ? "service.force-shutdown" : "service.draining",
      data: { activeWork: this.activeWork.size },
    });
    const work = [...this.activeWork.values()];
    for (const controller of this.deliveryMonitors.values()) controller.abort();
    this.deliveryMonitors.clear();
    if (force) await Promise.all(work.map((item) => item.interrupt()));
    else await Promise.all(work.map((item) => item.safeBoundary));

    for (const project of await this.registry.reconcile()) {
      if (project.availability !== "available") continue;
      const store = new RunEventStore(project.stateDirectory, {
        redaction: this.redactor,
      });
      for (const run of await this.listRuns(project)) {
        try {
          const loaded = await store.load(run.runId);
          if (["running", "blocked"].includes(loaded.state.run.status)) {
            await this.append(project.projectId, run.runId, {
              type: "run.transitioned",
              actor: { type: "service", id: "swf-service" },
              context: {},
              data: {
                from: loaded.state.run.status,
                to: "paused",
                reason: force
                  ? "forced service shutdown"
                  : "graceful service shutdown",
              },
            });
          }
          await store.rebuildSnapshot(run.runId);
        } catch (error) {
          this.broker.publish({
            type: "service.shutdown-error",
            runId: run.runId,
            projectId: project.projectId,
            data: {
              message:
                error instanceof Error
                  ? error.message
                  : "unknown shutdown error",
            },
          });
        }
      }
    }
    this.activeWork.clear();
    await this.audit.append({
      operation: "service.shutdown",
      actor: { type: "service-client", id: "authenticated-client" },
      outcome: "completed",
      details: { force },
    });
    this.broker.publish({ type: "service.stopped", data: { force } });
    await this.lock?.close();
    await rm(this.lockPath, { force: true });
    await rm(this.metadataPath, { force: true });
    this.lock = undefined;
    this.metadata = undefined;
  }

  private async reconcileRecoveredRun(
    project: RegisteredProject,
    state: RunState,
  ): Promise<RecoveryAction> {
    if (state.run.status === "paused")
      return { action: "pause", reason: "run was durably paused" };
    const runtime = new RunRuntime(
      new GitClient(project.root, this.commandRunner),
      this.herdr,
      new RuntimeOwnershipStore(project.stateDirectory),
    );
    const observed = await runtime.reconcile(state.run.runId);
    if (observed.status === "active") return { action: "resume" };
    if (observed.status === "blocked")
      return {
        action: "block",
        reason: `owned Herdr pane ${observed.paneId ?? "unknown"} is blocked`,
      };
    if (observed.status === "completed")
      return {
        action: "pause",
        reason:
          "owned execution completed; phase finalization must resume from durable evidence",
      };
    return {
      action: "block",
      reason: `owned execution resource is ${observed.status}`,
    };
  }

  async recover(reconcile?: RecoveryReconciler): Promise<void> {
    this.requireRunning();
    const projects = await this.registry.reconcile();
    for (const project of projects) {
      if (project.availability !== "available") continue;
      for (const run of await this.listRuns(project)) {
        const store = new RunEventStore(project.stateDirectory, {
          redaction: this.redactor,
        });
        const state = (await store.load(run.runId)).state;
        for (const delivery of Object.values(state.deliveries)) {
          if (
            delivery.status === "awaiting-merge" ||
            delivery.status === "auto-merge-requested"
          ) {
            try {
              const { request } = await this.deliveryRequest(
                project.projectId,
                run.runId,
              );
              this.startDeliveryMonitor(project.projectId, request, delivery);
            } catch (error) {
              this.broker.publish({
                type: "delivery.recovery-error",
                projectId: project.projectId,
                runId: run.runId,
                data: {
                  message:
                    error instanceof Error
                      ? error.message
                      : "delivery recovery failed",
                },
              });
            }
          }
        }
        if (!["running", "blocked", "paused"].includes(state.run.status))
          continue;
        const action = reconcile
          ? await reconcile(project, state)
          : await this.reconcileRecoveredRun(project, state);
        if (action.action === "resume") continue;
        const target =
          action.action === "complete"
            ? "completed"
            : action.action === "block"
              ? "blocked"
              : "paused";
        if (state.run.status !== target) {
          await this.append(project.projectId, run.runId, {
            type: "run.transitioned",
            actor: { type: "service", id: "swf-service" },
            context: {},
            data: { from: state.run.status, to: target, reason: action.reason },
          });
        }
        this.broker.publish({
          type: "run.recovered",
          projectId: project.projectId,
          runId: run.runId,
          data: { action: action.action },
        });
      }
    }
  }
}
