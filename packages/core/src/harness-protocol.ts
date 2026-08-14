import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  HarnessEventSchema,
  initialHarnessInvocationState,
  reduceHarnessEvent,
  type HarnessCorrelation,
  type HarnessEvent,
  type HarnessInvocationState,
} from "./harness-events.js";
import { Redactor } from "./security.js";

export interface HarnessInvocationMetadata extends HarnessCorrelation {
  schemaVersion: 1;
  codecVersion: string;
  cwd?: string;
  presentationLevel: string;
  createdAt: string;
  bridgePid?: number;
  nativePid?: number;
  captureHealth: "healthy" | "degraded" | "failed";
  presentationDegraded?: boolean;
  protocolModeAudited?: boolean;
  nativeAvailable?: boolean;
  nativePrunedAt?: string;
}
export interface HarnessCursor {
  schemaVersion: 1;
  nativeOffset: number;
  normalizedOffset: number;
  lastEventId?: string;
  updatedAt: string;
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export class HarnessProtocolStore {
  readonly directory: string;
  readonly metadataPath: string;
  readonly nativePath: string;
  readonly normalizedPath: string;
  readonly cursorPath: string;
  readonly controlPath: string;
  readonly serviceCursorPath: string;
  constructor(
    readonly stateDirectory: string,
    readonly runId: string,
    readonly invocationId: string,
    readonly redactor = new Redactor(),
  ) {
    if (
      !/^[A-Za-z0-9._-]+$/.test(runId) ||
      !/^[A-Za-z0-9._-]+$/.test(invocationId)
    )
      throw new Error("Unsafe run or invocation identifier");
    const root = resolve(stateDirectory, "runs", runId, "raw", "invocations");
    this.directory = resolve(root, invocationId);
    if (!this.directory.startsWith(`${root}${sep}`))
      throw new Error("Invocation path escapes raw state root");
    this.metadataPath = join(this.directory, "metadata.json");
    this.nativePath = join(this.directory, "native.jsonl");
    this.normalizedPath = join(this.directory, "normalized.jsonl");
    this.cursorPath = join(this.directory, "cursor.json");
    this.controlPath = join(this.directory, "control.jsonl");
    this.serviceCursorPath = join(this.directory, "service-cursor.json");
  }

  async initialize(metadata: HarnessInvocationMetadata): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await Promise.all([
      this.ensureFile(this.nativePath),
      this.ensureFile(this.normalizedPath),
      this.ensureFile(this.controlPath),
    ]);
    const recorded =
      metadata.presentationLevel === "protocol"
        ? { ...metadata, protocolModeAudited: true, nativeAvailable: true }
        : { ...metadata, nativeAvailable: true };
    await atomicWrite(
      this.metadataPath,
      `${JSON.stringify(this.redactor.value(recorded), null, 2)}\n`,
    );
    await this.writeCursor({
      schemaVersion: 1,
      nativeOffset: 0,
      normalizedOffset: 0,
      updatedAt: new Date().toISOString(),
    });
  }
  async metadata(): Promise<HarnessInvocationMetadata> {
    return JSON.parse(
      await readFile(this.metadataPath, "utf8"),
    ) as HarnessInvocationMetadata;
  }
  async updateMetadata(
    update: Partial<HarnessInvocationMetadata>,
  ): Promise<HarnessInvocationMetadata> {
    const next = this.redactor.value({ ...(await this.metadata()), ...update });
    await atomicWrite(this.metadataPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
  private async ensureFile(path: string) {
    const handle = await open(path, "a", 0o600);
    await handle.close();
    await chmod(path, 0o600);
  }
  private async append(path: string, value: unknown): Promise<number> {
    const line = `${JSON.stringify(this.redactor.value(value))}\n`;
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return Buffer.byteLength(line);
  }
  async appendNative(value: unknown): Promise<number> {
    return this.append(this.nativePath, value);
  }
  async appendNormalized(event: HarnessEvent): Promise<number> {
    return this.append(this.normalizedPath, HarnessEventSchema.parse(event));
  }
  async appendControl(value: unknown): Promise<number> {
    const line = `${JSON.stringify(value)}\n`;
    const handle = await open(this.controlPath, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(this.controlPath, 0o600);
    return Buffer.byteLength(line);
  }
  async controlSize(): Promise<number> {
    return (await lstat(this.controlPath).catch(() => undefined))?.size ?? 0;
  }
  async nativeRecordCount(): Promise<number> {
    const value = await readFile(this.nativePath, "utf8").catch(() => "");
    return value.split("\n").filter(Boolean).length;
  }
  async readControl(offset = 0): Promise<{
    commands: unknown[];
    offset: number;
  }> {
    const value = await readFile(this.controlPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const bytes = Buffer.from(value);
    if (offset > bytes.length) offset = 0;
    const unread = bytes.subarray(offset).toString("utf8");
    const finalLf = unread.lastIndexOf("\n");
    if (finalLf < 0) return { commands: [], offset };
    const complete = unread.slice(0, finalLf);
    const commands = complete
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    return {
      commands,
      offset: offset + Buffer.byteLength(unread.slice(0, finalLf + 1)),
    };
  }
  async readCursor(): Promise<HarnessCursor> {
    try {
      return JSON.parse(
        await readFile(this.cursorPath, "utf8"),
      ) as HarnessCursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.rebuildCursor();
    }
  }
  async writeCursor(cursor: HarnessCursor): Promise<void> {
    await atomicWrite(this.cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  }
  async rebuildCursor(): Promise<HarnessCursor> {
    const [native, normalized] = await Promise.all([
      readFile(this.nativePath, "utf8").catch(() => ""),
      readFile(this.normalizedPath, "utf8").catch(() => ""),
    ]);
    const events = normalized
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [HarnessEventSchema.parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    const cursor = {
      schemaVersion: 1 as const,
      nativeOffset: Buffer.byteLength(native),
      normalizedOffset: Buffer.byteLength(normalized),
      lastEventId: events.at(-1)?.eventId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeCursor(cursor);
    return cursor;
  }
  async events(): Promise<HarnessEvent[]> {
    return (await readFile(this.normalizedPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => HarnessEventSchema.parse(JSON.parse(line)));
  }
  async inspectNative(
    input: { start?: number; limit?: number; maxBytes?: number } = {},
  ): Promise<{ records: unknown[]; truncated: boolean }> {
    const start = Math.max(0, input.start ?? 0);
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const maxBytes = Math.min(256_000, Math.max(256, input.maxBytes ?? 32_000));
    const info = await lstat(this.nativePath);
    if (info.isSymbolicLink())
      throw new Error("Native protocol inspection refuses symbolic links");
    const lines = (await readFile(this.nativePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(start, start + limit);
    let bytes = 0;
    const records: unknown[] = [];
    let truncated = false;
    for (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      try {
        records.push(this.redactor.value(JSON.parse(line)));
      } catch {
        records.push(this.redactor.text(line.slice(0, 4096)));
      }
    }
    return { records, truncated };
  }
  async pruneNative(): Promise<void> {
    await unlink(this.nativePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

interface SerializedHarnessInvocationState extends Omit<
  HarnessInvocationState,
  "seenEventIds"
> {
  seenEventIds: string[];
}

export interface HarnessServiceCursor {
  schemaVersion: 1;
  offset: number;
  state: SerializedHarnessInvocationState;
  updatedAt: string;
}

export class HarnessNormalizedStreamConsumer {
  constructor(
    readonly store: HarnessProtocolStore,
    readonly maxBytes = 256_000,
  ) {}

  async load(): Promise<HarnessServiceCursor> {
    try {
      return JSON.parse(
        await readFile(this.store.serviceCursorPath, "utf8"),
      ) as HarnessServiceCursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.initialCursor();
      throw new Error(
        `Durable normalized cursor is unreadable for invocation ${this.store.invocationId}: ${this.store.serviceCursorPath}`,
        { cause: error },
      );
    }
  }

  async poll(): Promise<{
    events: HarnessEvent[];
    state: HarnessInvocationState;
    cursor: HarnessServiceCursor;
  }> {
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new Error(
        "Normalized stream polling requires a positive byte bound",
      );
    const previous = await this.load();
    const info = await lstat(this.store.normalizedPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          `Required normalized capture is missing for invocation ${this.store.invocationId}: ${this.store.normalizedPath}`,
          { cause: error },
        );
      throw error;
    });
    if (info.isSymbolicLink())
      throw new Error("Normalized stream consumer refuses symbolic links");
    if (previous.offset > info.size)
      throw new Error(
        "Normalized stream was truncated behind its durable cursor",
      );
    const handle = await open(this.store.normalizedPath, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(
      Math.min(this.maxBytes, info.size - previous.offset),
    );
    try {
      if (buffer.length)
        ({ bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          previous.offset,
        ));
    } finally {
      await handle.close();
    }
    const unread = buffer.subarray(0, bytesRead).toString("utf8");
    const finalLf = unread.lastIndexOf("\n");
    if (finalLf < 0 && bytesRead === this.maxBytes)
      throw new Error(
        `Normalized stream record exceeds the ${this.maxBytes}-byte polling bound`,
      );
    const complete = finalLf < 0 ? "" : unread.slice(0, finalLf);
    const consumedBytes =
      finalLf < 0 ? 0 : Buffer.byteLength(unread.slice(0, finalLf + 1));
    let state = this.deserialize(previous.state);
    const events: HarnessEvent[] = [];
    for (const line of complete.split("\n").filter(Boolean)) {
      let event: HarnessEvent;
      try {
        event = HarnessEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `Normalized capture is incompatible at byte ${previous.offset} for invocation ${this.store.invocationId}`,
          { cause: error },
        );
      }
      if (state.seenEventIds.has(event.eventId)) continue;
      state = reduceHarnessEvent(state, event);
      events.push(event);
    }
    const cursor: HarnessServiceCursor = {
      schemaVersion: 1,
      offset: previous.offset + consumedBytes,
      state: this.serialize(state),
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(
      this.store.serviceCursorPath,
      `${JSON.stringify(cursor, null, 2)}\n`,
    );
    return { events, state, cursor };
  }

  async reset(): Promise<void> {
    await atomicWrite(
      this.store.serviceCursorPath,
      `${JSON.stringify(this.initialCursor(), null, 2)}\n`,
    );
  }

  private initialCursor(): HarnessServiceCursor {
    return {
      schemaVersion: 1,
      offset: 0,
      state: this.serialize(initialHarnessInvocationState()),
      updatedAt: new Date().toISOString(),
    };
  }

  private serialize(
    state: HarnessInvocationState,
  ): SerializedHarnessInvocationState {
    return { ...state, seenEventIds: [...state.seenEventIds] };
  }

  private deserialize(
    state: SerializedHarnessInvocationState,
  ): HarnessInvocationState {
    return { ...state, seenEventIds: new Set(state.seenEventIds) };
  }
}
