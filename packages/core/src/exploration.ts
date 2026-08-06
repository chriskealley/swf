import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ExplorationBriefSchema,
  ExplorationSchema,
  type DocumentValue,
} from "./schemas.js";

export type Exploration = DocumentValue<"exploration">;
export type ExplorationBrief = DocumentValue<"explorationBrief">;

export interface ExplorationEvent {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  type:
    | "started"
    | "question"
    | "answer"
    | "transcript"
    | "brief-recorded"
    | "resumed"
    | "cancelled"
    | "discarded";
  data: Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function explorationEnvironment(
  explorationId: string,
): Record<string, string> {
  return { SWF_EXPLORATION_ID: explorationId, SWF_EXPLORATION_READ_ONLY: "1" };
}

/** Reject common mutating commands before dispatching an exploration operation. */
export function assertReadOnlyExplorationCommand(command: string): void {
  const mutating =
    /(^|\s)(git\s+(add|commit|reset|clean|checkout|switch|merge|rebase)|rm\s|mv\s|cp\s|mkdir\s|touch\s|tee\s|sed\s+-i|apply_patch|writeFile)(\s|$)/;
  if (mutating.test(command))
    throw new Error(
      "Exploration is read-only and cannot execute mutating commands",
    );
}

export interface ReadOnlyExplorationExecutor {
  execute(input: {
    exploration: Exploration;
    instruction: string;
    environment: Record<string, string>;
  }): Promise<{ transcript: string; question?: string }>;
}

export class ExplorationStore {
  constructor(readonly stateDirectory: string) {}

  private root(id: string): string {
    return join(this.stateDirectory, "explorations", id);
  }
  private metadataPath(id: string): string {
    return join(this.root(id), "exploration.json");
  }
  private eventsPath(id: string): string {
    return join(this.root(id), "events.jsonl");
  }
  private transcriptPath(id: string): string {
    return join(this.root(id), "transcript.log");
  }
  private briefPath(id: string): string {
    return join(this.root(id), "brief.json");
  }

  async start(
    idea: string,
    explorationId = randomUUID(),
  ): Promise<Exploration> {
    const now = new Date().toISOString();
    const exploration = ExplorationSchema.parse({
      schemaVersion: 1,
      explorationId,
      idea: idea.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    if (!exploration.idea) throw new Error("Exploration idea is required");
    await writeJson(this.metadataPath(explorationId), exploration);
    await this.event(explorationId, "started", { idea: exploration.idea });
    return exploration;
  }

  async get(explorationId: string): Promise<Exploration> {
    return ExplorationSchema.parse(
      JSON.parse(await readFile(this.metadataPath(explorationId), "utf8")),
    );
  }

  async list(): Promise<Exploration[]> {
    const directory = join(this.stateDirectory, "explorations");
    try {
      const entries = await (
        await import("node:fs/promises")
      ).readdir(directory, { withFileTypes: true });
      return (
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => this.get(entry.name)),
        )
      ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async event(
    explorationId: string,
    type: ExplorationEvent["type"],
    data: Record<string, unknown>,
  ): Promise<ExplorationEvent> {
    const event: ExplorationEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    await mkdir(this.root(explorationId), { recursive: true, mode: 0o700 });
    await writeFile(
      this.eventsPath(explorationId),
      `${JSON.stringify(event)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "a" },
    );
    return event;
  }

  async events(explorationId: string): Promise<ExplorationEvent[]> {
    try {
      return (await readFile(this.eventsPath(explorationId), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ExplorationEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async appendTranscript(explorationId: string, output: string): Promise<void> {
    await mkdir(this.root(explorationId), { recursive: true, mode: 0o700 });
    await writeFile(this.transcriptPath(explorationId), output, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    await this.event(explorationId, "transcript", {
      bytes: Buffer.byteLength(output),
    });
  }

  async executeReadOnly(
    explorationId: string,
    instruction: string,
    executor: ReadOnlyExplorationExecutor,
  ): Promise<{ transcript: string; question?: string }> {
    const exploration = await this.get(explorationId);
    if (exploration.status !== "active")
      throw new Error(`Exploration is not active: ${exploration.status}`);
    const result = await executor.execute({
      exploration,
      instruction,
      environment: explorationEnvironment(explorationId),
    });
    await this.appendTranscript(explorationId, result.transcript);
    if (result.question)
      await this.event(explorationId, "question", {
        question: result.question,
      });
    return result;
  }

  async answer(explorationId: string, answer: string): Promise<void> {
    if (!answer.trim()) throw new Error("Exploration answer is required");
    await this.event(explorationId, "answer", { answer: answer.trim() });
  }

  async recordBrief(
    brief: Omit<ExplorationBrief, "schemaVersion">,
  ): Promise<ExplorationBrief> {
    const parsed = ExplorationBriefSchema.parse({ ...brief, schemaVersion: 1 });
    const exploration = await this.get(parsed.explorationId);
    if (exploration.status === "discarded")
      throw new Error("Discarded exploration cannot be promoted");
    await writeJson(this.briefPath(parsed.explorationId), parsed);
    const updated = ExplorationSchema.parse({
      ...exploration,
      status: "completed",
      updatedAt: new Date().toISOString(),
      brief: parsed,
    });
    await writeJson(this.metadataPath(parsed.explorationId), updated);
    await this.event(parsed.explorationId, "brief-recorded", {
      candidateChangeName: parsed.candidateChangeName,
    });
    return parsed;
  }

  async resume(explorationId: string): Promise<Exploration> {
    const exploration = await this.get(explorationId);
    if (exploration.status === "discarded")
      throw new Error("Discarded exploration cannot be resumed");
    const updated = ExplorationSchema.parse({
      ...exploration,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await writeJson(this.metadataPath(explorationId), updated);
    await this.event(explorationId, "resumed", {});
    return updated;
  }

  async cancel(explorationId: string): Promise<Exploration> {
    return this.setStatus(explorationId, "cancelled", "cancelled");
  }
  async discard(explorationId: string): Promise<Exploration> {
    return this.setStatus(explorationId, "discarded", "discarded");
  }

  private async setStatus(
    explorationId: string,
    status: Exploration["status"],
    event: ExplorationEvent["type"],
  ): Promise<Exploration> {
    const exploration = await this.get(explorationId);
    const updated = ExplorationSchema.parse({
      ...exploration,
      status,
      updatedAt: new Date().toISOString(),
    });
    await writeJson(this.metadataPath(explorationId), updated);
    await this.event(explorationId, event, {});
    return updated;
  }

  async promote(explorationId: string): Promise<ExplorationBrief> {
    const exploration = await this.get(explorationId);
    if (exploration.status === "discarded")
      throw new Error("Discarded exploration cannot be promoted");
    if (!exploration.brief)
      throw new Error("Exploration has no brief to promote");
    return ExplorationBriefSchema.parse(exploration.brief);
  }

  async retainedBytes(explorationId: string): Promise<number> {
    const files = [
      this.metadataPath(explorationId),
      this.eventsPath(explorationId),
      this.transcriptPath(explorationId),
      this.briefPath(explorationId),
    ];
    return (
      await Promise.all(
        files.map(async (file) => {
          try {
            return (await stat(file)).size;
          } catch {
            return 0;
          }
        }),
      )
    ).reduce((sum, size) => sum + size, 0);
  }

  async removeForTests(explorationId: string): Promise<void> {
    await rm(this.root(explorationId), { recursive: true, force: true });
  }
}
