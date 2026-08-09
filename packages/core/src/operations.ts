import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { RunSchema } from "./schemas.js";
import { RunEventStore, withFileLock } from "./event-store.js";
import type { RunState } from "./domain.js";
import type { RunRuntimeOwnership } from "./runtime.js";

interface ArchivedFile {
  path: string;
  bytes: number;
  sha256: string;
  data: string;
}

export interface RunExport {
  schemaVersion: 1;
  exportId: string;
  runId: string;
  createdAt: string;
  files: ArchivedFile[];
  manifestSha256: string;
}

async function filesBelow(
  root: string,
  exclude: (path: string) => boolean = () => false,
): Promise<ArchivedFile[]> {
  const files: ArchivedFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const pathRelative = relative(root, path).replaceAll("\\", "/");
      if (exclude(pathRelative)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        files.push({
          path: pathRelative,
          bytes: contents.byteLength,
          sha256: createHash("sha256").update(contents).digest("hex"),
          data: contents.toString("base64"),
        });
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function manifestHash(files: ArchivedFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      ),
    )
    .digest("hex");
}

function safeArchivePath(root: string, candidate: string): string {
  const path = resolve(root, candidate);
  if (
    !candidate ||
    candidate.startsWith("/") ||
    relative(root, path).startsWith("..")
  )
    throw new Error(`Archive path escapes its destination: ${candidate}`);
  return path;
}

async function restoreFiles(
  root: string,
  files: ArchivedFile[],
): Promise<void> {
  for (const file of files) {
    const contents = Buffer.from(file.data, "base64");
    if (
      contents.byteLength !== file.bytes ||
      createHash("sha256").update(contents).digest("hex") !== file.sha256
    )
      throw new Error(`Archive checksum mismatch: ${file.path}`);
    const path = safeArchivePath(root, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o600 });
  }
}

export async function exportRun(
  stateDirectory: string,
  runId: string,
  outputPath?: string,
): Promise<RunExport> {
  const root = join(stateDirectory, "runs", runId);
  const info = await stat(root);
  if (!info.isDirectory())
    throw new Error(`Run directory is missing: ${runId}`);
  const files = await filesBelow(root);
  if (!files.some((file) => file.path === "run.json"))
    throw new Error(`Run ${runId} has no run.json`);
  const archive: RunExport = {
    schemaVersion: 1,
    exportId: randomUUID(),
    runId,
    createdAt: new Date().toISOString(),
    files,
    manifestSha256: manifestHash(files),
  };
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, `${JSON.stringify(archive)}\n`, {
      mode: 0o600,
    });
  }
  return archive;
}

export async function importRun(
  stateDirectory: string,
  input: string | RunExport,
): Promise<{ runId: string; files: number }> {
  const archive =
    typeof input === "string"
      ? (JSON.parse(await readFile(input, "utf8")) as RunExport)
      : input;
  if (
    archive.schemaVersion !== 1 ||
    !Array.isArray(archive.files) ||
    manifestHash(archive.files) !== archive.manifestSha256
  )
    throw new Error("Invalid or corrupted SWF run export");
  const runFile = archive.files.find((file) => file.path === "run.json");
  if (!runFile) throw new Error("Run export is missing run.json");
  const run = RunSchema.parse(
    JSON.parse(Buffer.from(runFile.data, "base64").toString("utf8")),
  );
  if (run.runId !== archive.runId)
    throw new Error("Run export identity does not match run.json");
  const destination = join(stateDirectory, "runs", run.runId);
  try {
    await stat(destination);
    throw new Error(`Run already exists: ${run.runId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.importing`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    await restoreFiles(temporary, archive.files);
    await rename(temporary, destination);
    await new RunEventStore(stateDirectory).load(run.runId);
    await withFileLock(
      join(stateDirectory, "locks", "run-bindings.lock"),
      async () => {
        const path = join(stateDirectory, "run-bindings.json");
        let bindings: {
          schemaVersion: 1;
          byChangeIdentity: Record<string, string>;
        } = { schemaVersion: 1, byChangeIdentity: {} };
        try {
          bindings = JSON.parse(
            await readFile(path, "utf8"),
          ) as typeof bindings;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (
          run.changeIdentity &&
          bindings.byChangeIdentity[run.changeIdentity] &&
          bindings.byChangeIdentity[run.changeIdentity] !== run.runId
        )
          throw new Error(
            `OpenSpec change is already bound: ${run.changeIdentity}`,
          );
        if (run.changeIdentity)
          bindings.byChangeIdentity[run.changeIdentity] = run.runId;
        await writeFile(path, `${JSON.stringify(bindings, null, 2)}\n`, {
          mode: 0o600,
        });
      },
    );
    return { runId: run.runId, files: archive.files.length };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export interface StateMigration {
  from: number;
  to: number;
  description: string;
  apply(stateDirectory: string): Promise<void>;
}

export interface MigrationPlan {
  from: number;
  to: number;
  migrations: Array<Pick<StateMigration, "from" | "to" | "description">>;
}

interface StateVersion {
  schemaVersion: 1;
  stateVersion: number;
  updatedAt: string;
}

export class StateMigrationManager {
  constructor(
    readonly stateDirectory: string,
    readonly migrations: StateMigration[] = [],
    readonly currentVersion = 1,
  ) {}

  private async version(): Promise<number> {
    try {
      const value = JSON.parse(
        await readFile(join(this.stateDirectory, "state-version.json"), "utf8"),
      ) as StateVersion;
      return value.stateVersion;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.currentVersion;
      throw error;
    }
  }

  async plan(target = this.currentVersion): Promise<MigrationPlan> {
    const from = await this.version();
    const selected: StateMigration[] = [];
    let cursor = from;
    while (cursor < target) {
      const migration = this.migrations.find((entry) => entry.from === cursor);
      if (!migration || migration.to <= cursor)
        throw new Error(`No state migration from version ${cursor}`);
      selected.push(migration);
      cursor = migration.to;
    }
    if (cursor !== target)
      throw new Error(`Migration chain ends at ${cursor}, expected ${target}`);
    return {
      from,
      to: target,
      migrations: selected.map(({ from, to, description }) => ({
        from,
        to,
        description,
      })),
    };
  }

  async migrate(input: { target?: number; dryRun?: boolean } = {}): Promise<{
    plan: MigrationPlan;
    applied: boolean;
    backupId?: string;
  }> {
    const plan = await this.plan(input.target);
    if (input.dryRun || !plan.migrations.length)
      return { plan, applied: false };
    const backupId = `${Date.now()}-${randomUUID()}`;
    const backupPath = join(this.stateDirectory, "backups", `${backupId}.json`);
    const files = await filesBelow(
      this.stateDirectory,
      (path) => path === "backups" || path.startsWith("backups/"),
    );
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFile(
      backupPath,
      `${JSON.stringify({ schemaVersion: 1, backupId, files, manifestSha256: manifestHash(files) })}\n`,
      { mode: 0o600 },
    );
    try {
      for (const planned of plan.migrations) {
        const migration = this.migrations.find(
          (entry) => entry.from === planned.from && entry.to === planned.to,
        )!;
        await migration.apply(this.stateDirectory);
        const version: StateVersion = {
          schemaVersion: 1,
          stateVersion: migration.to,
          updatedAt: new Date().toISOString(),
        };
        await writeFile(
          join(this.stateDirectory, "state-version.json"),
          `${JSON.stringify(version, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      return { plan, applied: true, backupId };
    } catch (error) {
      await this.rollback(backupId);
      throw error;
    }
  }

  async rollback(backupId: string): Promise<void> {
    const backupPath = join(this.stateDirectory, "backups", `${backupId}.json`);
    const backup = JSON.parse(await readFile(backupPath, "utf8")) as {
      files: ArchivedFile[];
      manifestSha256: string;
    };
    if (manifestHash(backup.files) !== backup.manifestSha256)
      throw new Error("State backup manifest is corrupted");
    for (const entry of await readdir(this.stateDirectory)) {
      if (entry !== "backups")
        await rm(join(this.stateDirectory, entry), {
          recursive: true,
          force: true,
        });
    }
    await restoreFiles(this.stateDirectory, backup.files);
  }
}

export interface OperationalHealth {
  checkedAt: string;
  stuck: Array<{
    runId: string;
    invocationId: string;
    phaseId: string;
    startedAt: string;
    ageMs: number;
  }>;
  orphans: Array<{
    runId: string;
    runStatus: string;
    resources: RunRuntimeOwnership["resources"];
  }>;
  errors: Array<{ runId: string; message: string }>;
}

export async function inspectOperationalHealth(
  stateDirectory: string,
  staleAfterMs = 30 * 60_000,
  now = Date.now(),
): Promise<OperationalHealth> {
  const report: OperationalHealth = {
    checkedAt: new Date(now).toISOString(),
    stuck: [],
    orphans: [],
    errors: [],
  };
  let entries;
  try {
    entries = await readdir(join(stateDirectory, "runs"), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw error;
  }
  const store = new RunEventStore(stateDirectory);
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    try {
      const state: RunState = (await store.load(entry.name)).state;
      for (const invocation of Object.values(state.invocations)) {
        const ageMs = now - new Date(invocation.startedAt).getTime();
        if (
          ["running", "blocked"].includes(invocation.status) &&
          !invocation.endedAt &&
          ageMs >= staleAfterMs
        )
          report.stuck.push({
            runId: entry.name,
            invocationId: invocation.invocationId,
            phaseId: invocation.phaseId,
            startedAt: invocation.startedAt,
            ageMs,
          });
      }
      try {
        const runtime = JSON.parse(
          await readFile(
            join(stateDirectory, "runs", entry.name, "runtime.json"),
            "utf8",
          ),
        ) as RunRuntimeOwnership;
        if (
          ["completed", "failed", "cancelled", "skipped"].includes(
            state.run.status,
          ) &&
          runtime.resources.length
        )
          report.orphans.push({
            runId: entry.name,
            runStatus: state.run.status,
            resources: runtime.resources,
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      report.errors.push({
        runId: entry.name,
        message: error instanceof Error ? error.message : "inspection failed",
      });
    }
  }
  return report;
}
