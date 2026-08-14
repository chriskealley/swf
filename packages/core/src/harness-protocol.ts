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
  type HarnessCorrelation,
  type HarnessEvent,
} from "./harness-events.js";
import { Redactor } from "./security.js";

export interface HarnessInvocationMetadata extends HarnessCorrelation {
  schemaVersion: 1;
  codecVersion: string;
  presentationLevel: string;
  createdAt: string;
  bridgePid?: number;
  nativePid?: number;
  captureHealth: "healthy" | "degraded" | "failed";
  presentationDegraded?: boolean;
  protocolModeAudited?: boolean;
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
  }

  async initialize(metadata: HarnessInvocationMetadata): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await Promise.all([
      this.ensureFile(this.nativePath),
      this.ensureFile(this.normalizedPath),
    ]);
    const recorded =
      metadata.presentationLevel === "protocol"
        ? { ...metadata, protocolModeAudited: true }
        : metadata;
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
