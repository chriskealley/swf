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
  BlockedAgentRouter,
  RunEventStore,
  createRunEvent,
  findProjectRoot,
  reduceRunState,
  validateProjectConfiguration,
  type AdapterInvocation,
  type AdapterObservation,
  type EventDraft,
  type EventType,
  type HarnessAdapter,
  type Run,
  type RunState,
} from "@swf/core";

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
  private readonly retained: ServiceEvent[] = [];
  private readonly subscribers = new Set<AsyncEventSubscription>();

  publish(event: Omit<ServiceEvent, "id" | "timestamp">): ServiceEvent {
    const published: ServiceEvent = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      ...event,
    };
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
}

export interface ServiceQuery {
  resource:
    | "overview"
    | "projects"
    | "runs"
    | "run"
    | "phases"
    | "invocations"
    | "artifacts"
    | "costs"
    | "configuration"
    | "delivery"
    | "output"
    | "blocked-inputs";
  projectId?: string;
  runId?: string;
  ref?: string;
  raw?: boolean;
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

export type ServiceCommand =
  | {
      type: "start" | "pause" | "resume" | "cancel";
      projectId: string;
      runId: string;
    }
  | {
      type: "approve" | "reject";
      projectId: string;
      runId: string;
      phaseId: string;
      gateId: string;
      reason?: string;
      actorId: string;
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
    }
  | { type: "blocked-input"; invocationId: string; response: string };

export class SwfService {
  readonly serviceHome: string;
  readonly endpoint: string;
  readonly registry: ProjectRegistry;
  private readonly broker = new EventBroker();
  private readonly blockedAgents = new BlockedAgentRouter();
  private readonly activeWork = new Map<string, WorkRegistration>();
  private readonly pendingPruning = new Map<string, PendingPruning>();
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
    this.registry = new ProjectRegistry(this.serviceHome);
  }

  private get lockPath(): string {
    return join(this.serviceHome, "service.lock");
  }

  private get metadataPath(): string {
    return join(this.serviceHome, "service.json");
  }

  async start(): Promise<ServiceMetadata> {
    if (this.metadata) return this.metadata;
    await mkdir(this.serviceHome, { recursive: true, mode: 0o700 });
    try {
      this.lock = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ServiceAlreadyRunningError(
        await readJson<ServiceMetadata>(this.metadataPath),
      );
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
      this.metadata = metadata;
      this.acceptingWork = true;
      this.broker.publish({
        type: "service.started",
        data: { serviceId: metadata.serviceId, endpoint: metadata.endpoint },
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
    const project = await this.registry.register(input);
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
    return project;
  }

  private async runStore(
    projectId: string,
  ): Promise<{ project: RegisteredProject; store: RunEventStore }> {
    const project = await this.project(projectId);
    return { project, store: new RunEventStore(project.stateDirectory) };
  }

  private async listRuns(project: RegisteredProject): Promise<Run[]> {
    try {
      const entries = await readdir(join(project.stateDirectory, "runs"), {
        withFileTypes: true,
      });
      const store = new RunEventStore(project.stateDirectory);
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
        const store = new RunEventStore(project.stateDirectory);
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
        content: returned.toString("utf8"),
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
          reason: "Output was pruned or is unavailable",
        };
      throw error;
    }
  }

  async query(query: ServiceQuery): Promise<unknown> {
    this.requireRunning();
    if (query.resource === "overview") return this.overview();
    if (query.resource === "projects") return this.registry.reconcile();
    if (query.resource === "blocked-inputs") return this.blockedInputs();
    if (!query.projectId)
      throw new Error(`projectId is required for ${query.resource}`);
    const { project, store } = await this.runStore(query.projectId);
    if (query.resource === "runs") return this.listRuns(project);
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
    if (!query.runId)
      throw new Error(`runId is required for ${query.resource}`);
    if (query.resource === "output") {
      if (!query.ref) throw new Error("ref is required for output");
      return this.readOutput(project, query.runId, query.ref, query.raw);
    }
    const loaded = await store.load(query.runId);
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
      case "phases":
        return loaded.state.phases;
      case "invocations":
        return loaded.state.invocations;
      case "artifacts":
        return loaded.state.artifacts;
      case "delivery":
        return loaded.state.deliveries;
      case "costs":
        return this.summarizeCosts(loaded.state.invocations);
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
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        await rm(path);
        pruned += 1;
        bytes += info.size;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const candidate = preview.candidates[index];
      if (candidate)
        this.broker.publish({
          type: "output.pruned",
          projectId,
          runId: candidate.runId,
          data: { ref: candidate.ref, bytes: candidate.bytes },
        });
    }
    this.pendingPruning.delete(confirmationId);
    return { pruned, bytes };
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
    }
  }

  async command(command: ServiceCommand): Promise<void> {
    this.requireRunning();
    if (command.type === "blocked-input") {
      await this.submitBlockedInput(command.invocationId, command.response);
      return;
    }
    if (!this.acceptingWork && command.type === "start")
      throw new Error("SWF service is draining and cannot start new work");
    const { store } = await this.runStore(command.projectId);
    const loaded = await store.load(command.runId);
    const actor = { type: "service" as const, id: "swf-service" };
    if (
      command.type === "start" ||
      command.type === "pause" ||
      command.type === "resume" ||
      command.type === "cancel"
    ) {
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
    if (command.type === "approve" || command.type === "reject") {
      await this.append(command.projectId, command.runId, {
        type: "gate.decided",
        actor: { type: "user", id: command.actorId },
        context: { phaseId: command.phaseId },
        data: {
          gateId: command.gateId,
          phaseId: command.phaseId,
          status: command.type === "approve" ? "satisfied" : "rejected",
          reason: command.reason,
        },
      });
      return;
    }
    if (command.type === "remediate" || command.type === "rollback") {
      const attemptId = randomUUID();
      const kind = command.type === "remediate" ? "remediation" : "rollback";
      const number =
        (loaded.state.phases[command.phaseId]?.attemptIds.length ?? 0) + 1;
      await this.append(command.projectId, command.runId, {
        type: "attempt.started",
        actor,
        context: { phaseId: command.phaseId, attemptId },
        data: { attemptId, phaseId: command.phaseId, number, kind },
      });
      if (command.type === "remediate") {
        await this.append(command.projectId, command.runId, {
          type: "run.remediated",
          actor,
          context: { phaseId: command.phaseId, attemptId },
          data: { phaseId: command.phaseId, attemptId, reason: command.reason },
        });
      } else {
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
      }
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
    if (force) await Promise.all(work.map((item) => item.interrupt()));
    else await Promise.all(work.map((item) => item.safeBoundary));

    for (const project of await this.registry.reconcile()) {
      if (project.availability !== "available") continue;
      const store = new RunEventStore(project.stateDirectory);
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
    this.broker.publish({ type: "service.stopped", data: { force } });
    await this.lock?.close();
    await rm(this.lockPath, { force: true });
    await rm(this.metadataPath, { force: true });
    this.lock = undefined;
    this.metadata = undefined;
  }

  async recover(
    reconcile: RecoveryReconciler = async () => ({
      action: "pause",
      reason: "service restart requires reconciliation",
    }),
  ): Promise<void> {
    this.requireRunning();
    const projects = await this.registry.reconcile();
    for (const project of projects) {
      if (project.availability !== "available") continue;
      for (const run of await this.listRuns(project)) {
        const store = new RunEventStore(project.stateDirectory);
        const state = (await store.load(run.runId)).state;
        if (!["running", "blocked", "paused"].includes(state.run.status))
          continue;
        const action = await reconcile(project, state);
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
