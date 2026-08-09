import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type EventDraft,
  type EventType,
  type Run,
  type RunEvent,
  type RunState,
  createRunEvent,
  reconstructRunState,
  parseRunEvent,
} from "./domain.js";
import { RunSchema, SnapshotSchema, type DocumentValue } from "./schemas.js";
import { Redactor, type RedactionOptions } from "./security.js";

const RUNS_DIRECTORY = "runs";
const EVENTS_FILE = "events.jsonl";
const RUN_FILE = "run.json";
const SNAPSHOT_FILE = "snapshot.json";

export class DuplicateRunError extends Error {
  constructor(
    readonly changeIdentity: string,
    readonly runId: string,
  ) {
    super(`OpenSpec change ${changeIdentity} is already bound to run ${runId}`);
    this.name = "DuplicateRunError";
  }
}

export class CorruptEventLogError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    readonly cause: unknown,
  ) {
    super(`Corrupt event log at ${path}:${line}`);
    this.name = "CorruptEventLogError";
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 60_000;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      await handle.close();
      try {
        return await operation();
      } finally {
        await rm(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStats = await stat(path);
        if (Date.now() - lockStats.mtimeMs > staleMs) {
          await rm(path, { force: true });
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`Unable to inspect lock: ${path}`, {
            cause: lockError,
          });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${path}`, { cause: error });
      }
      await sleep(pollMs);
    }
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

interface Bindings {
  schemaVersion: 1;
  byChangeIdentity: Record<string, string>;
}

export interface CreateRunInput {
  projectId: string;
  changeName: string;
  /** A stable OpenSpec identity, such as its resolved change directory. */
  changeIdentity: string;
  workflowId: string;
  description: string;
  phaseIds: string[];
  runId?: string;
  createdAt?: string;
}

export interface SnapshotResult {
  status: "fresh" | "stale" | "missing" | "corrupt";
  snapshot?: DocumentValue<"snapshot">;
}

export interface LoadedRun {
  run: Run;
  events: RunEvent[];
  state: RunState;
  snapshot: SnapshotResult;
}

export interface AppendResult<T extends EventType = EventType> {
  event: RunEvent<T>;
  appended: boolean;
}

export type EventStoreWritePoint =
  "run" | "initial-event" | "bindings" | "event" | "snapshot";

export interface RunEventStoreOptions {
  redaction?: RedactionOptions | Redactor;
  beforeWrite?: (
    point: EventStoreWritePoint,
    path: string,
  ) => void | Promise<void>;
}

export class RunEventStore {
  readonly redactor: Redactor;

  constructor(
    readonly stateDirectory: string,
    readonly options: RunEventStoreOptions = {},
  ) {
    this.redactor =
      options.redaction instanceof Redactor
        ? options.redaction
        : new Redactor(options.redaction);
  }

  private async beforeWrite(
    point: EventStoreWritePoint,
    path: string,
  ): Promise<void> {
    await this.options.beforeWrite?.(point, path);
  }

  private runDirectory(runId: string): string {
    return join(this.stateDirectory, RUNS_DIRECTORY, runId);
  }

  private runPath(runId: string): string {
    return join(this.runDirectory(runId), RUN_FILE);
  }

  private eventsPath(runId: string): string {
    return join(this.runDirectory(runId), EVENTS_FILE);
  }

  private snapshotPath(runId: string): string {
    return join(this.runDirectory(runId), SNAPSHOT_FILE);
  }

  private eventLockPath(runId: string): string {
    return join(this.stateDirectory, "locks", `${runId}.events.lock`);
  }

  private bindingsPath(): string {
    return join(this.stateDirectory, "run-bindings.json");
  }

  private bindingsLockPath(): string {
    return join(this.stateDirectory, "locks", "run-bindings.lock");
  }

  private async readBindings(): Promise<Bindings> {
    try {
      const bindings = JSON.parse(
        await readFile(this.bindingsPath(), "utf8"),
      ) as Bindings;
      if (bindings.schemaVersion === 1 && bindings.byChangeIdentity)
        return bindings;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return { schemaVersion: 1, byChangeIdentity: {} };
  }

  async create(input: CreateRunInput): Promise<Run> {
    return withFileLock(this.bindingsLockPath(), async () => {
      const bindings = await this.readBindings();
      const existingRunId = bindings.byChangeIdentity[input.changeIdentity];
      if (existingRunId)
        throw new DuplicateRunError(input.changeIdentity, existingRunId);

      const createdAt = input.createdAt ?? new Date().toISOString();
      const run = RunSchema.parse(
        this.redactor.value({
          schemaVersion: 1,
          runId: input.runId ?? randomUUID(),
          projectId: input.projectId,
          changeName: input.changeName,
          changeIdentity: input.changeIdentity,
          workflowId: input.workflowId,
          phaseIds: input.phaseIds,
          description: input.description,
          status: "pending",
          createdAt,
          updatedAt: createdAt,
        }),
      );
      await this.beforeWrite("run", this.runPath(run.runId));
      await writeAtomically(
        this.runPath(run.runId),
        `${JSON.stringify(run, null, 2)}\n`,
      );
      const created = createRunEvent({
        runId: run.runId,
        sequence: 0,
        timestamp: createdAt,
        type: "run.created",
        actor: { type: "system", id: "swf" },
        context: {},
        data: { changeIdentity: input.changeIdentity },
      });
      await this.beforeWrite("initial-event", this.eventsPath(run.runId));
      await writeAtomically(
        this.eventsPath(run.runId),
        `${JSON.stringify(created)}\n`,
      );
      bindings.byChangeIdentity[input.changeIdentity] = run.runId;
      await this.beforeWrite("bindings", this.bindingsPath());
      await writeAtomically(
        this.bindingsPath(),
        `${JSON.stringify(bindings, null, 2)}\n`,
      );
      return run;
    });
  }

  async findRunByChangeIdentity(
    changeIdentity: string,
  ): Promise<string | undefined> {
    return (await this.readBindings()).byChangeIdentity[changeIdentity];
  }

  async readRun(runId: string): Promise<Run> {
    return RunSchema.parse(
      JSON.parse(await readFile(this.runPath(runId), "utf8")),
    );
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    const path = this.eventsPath(runId);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const lines = contents.split("\n");
    const hasFinalNewline = contents.endsWith("\n");
    const events: RunEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      try {
        events.push(parseRunEvent(JSON.parse(line)));
      } catch (error) {
        const isTrailingPartialLine =
          index === lines.length - 1 && !hasFinalNewline;
        if (isTrailingPartialLine) break;
        throw new CorruptEventLogError(path, index + 1, error);
      }
    }
    return events;
  }

  private async repairInterruptedTail(runId: string): Promise<void> {
    const path = this.eventsPath(runId);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (!contents || contents.endsWith("\n")) return;

    const finalLineStart = contents.lastIndexOf("\n") + 1;
    try {
      parseRunEvent(JSON.parse(contents.slice(finalLineStart)));
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile("\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      const handle = await open(path, "w", 0o600);
      try {
        await handle.writeFile(contents.slice(0, finalLineStart), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  async append<T extends EventType>(
    runId: string,
    draft: EventDraft<T>,
  ): Promise<AppendResult<T>> {
    return withFileLock(this.eventLockPath(runId), async () => {
      await this.repairInterruptedTail(runId);
      const existing = await this.readEvents(runId);
      const duplicate = existing.find(
        (event) =>
          (draft.eventId !== undefined && event.eventId === draft.eventId) ||
          (draft.idempotencyKey !== undefined &&
            event.idempotencyKey === draft.idempotencyKey),
      );
      if (duplicate)
        return { event: duplicate as RunEvent<T>, appended: false };

      const event = createRunEvent({
        ...draft,
        data: this.redactor.value(draft.data),
        runId,
        sequence: (existing.at(-1)?.sequence ?? -1) + 1,
      });
      await this.beforeWrite("event", this.eventsPath(runId));
      const handle = await open(this.eventsPath(runId), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { event: event as RunEvent<T>, appended: true };
    });
  }

  async readSnapshot(
    runId: string,
    events?: readonly RunEvent[],
  ): Promise<SnapshotResult> {
    const resolvedEvents = events ?? (await this.readEvents(runId));
    try {
      const snapshot = SnapshotSchema.parse(
        JSON.parse(await readFile(this.snapshotPath(runId), "utf8")),
      );
      if (
        snapshot.runId !== runId ||
        snapshot.sequence !== (resolvedEvents.at(-1)?.sequence ?? -1)
      ) {
        return { status: "stale", snapshot };
      }
      return { status: "fresh", snapshot };
    } catch (error) {
      if (isNotFound(error)) return { status: "missing" };
      return { status: "corrupt" };
    }
  }

  async rebuildSnapshot(runId: string): Promise<DocumentValue<"snapshot">> {
    const run = await this.readRun(runId);
    const events = await this.readEvents(runId);
    const state = reconstructRunState(run, events);
    const snapshot = SnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      sequence: state.lastSequence,
      createdAt: new Date().toISOString(),
      state,
    });
    await this.beforeWrite("snapshot", this.snapshotPath(runId));
    await writeAtomically(
      this.snapshotPath(runId),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    return snapshot;
  }

  async load(runId: string): Promise<LoadedRun> {
    const run = await this.readRun(runId);
    const events = await this.readEvents(runId);
    return {
      run,
      events,
      state: reconstructRunState(run, events),
      snapshot: await this.readSnapshot(runId, events),
    };
  }
}
