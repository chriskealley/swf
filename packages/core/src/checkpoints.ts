import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ArtifactStore } from "./artifacts.js";
import { type Checkpoint } from "./domain.js";
import { type RunEventStore } from "./event-store.js";
import { type CommandRunner, type GitClient } from "./git.js";
import { CheckpointSchema, type DocumentValue } from "./schemas.js";

function redactPortableText(value: string): string {
  return value.replace(
    /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
}

function portableHandoff(
  handoff: DocumentValue<"handoff">,
): DocumentValue<"handoff"> {
  return {
    ...handoff,
    summary: handoff.summary.map(redactPortableText),
    decisions: handoff.decisions.map(redactPortableText),
    knownIssues: handoff.knownIssues.map(redactPortableText),
    recommendedNextActions:
      handoff.recommendedNextActions.map(redactPortableText),
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export interface PhaseCheckpointInput {
  phaseId: string;
  beforeCommit: string;
  gateDecision: "satisfied" | "rejected" | "blocked" | "skipped";
  handoff?: DocumentValue<"handoff">;
  message?: string;
}

export class CheckpointManager {
  constructor(
    readonly stateDirectory: string,
    readonly runId: string,
    readonly git: GitClient,
    readonly artifacts: ArtifactStore,
    readonly events?: RunEventStore,
  ) {}

  private directory(): string {
    return join(this.stateDirectory, "runs", this.runId, "checkpoints");
  }
  private path(checkpointId: string): string {
    return join(this.directory(), `${checkpointId}.json`);
  }

  async create(input: PhaseCheckpointInput): Promise<Checkpoint> {
    if (input.gateDecision !== "satisfied")
      throw new Error("A phase checkpoint requires a satisfied gate");
    const beforeStatus = await this.git.status();
    const committed = await this.git.commit(
      input.message ?? `swf(${input.phaseId}): checkpoint`,
    );
    const [afterCommit, status, manifest] = await Promise.all([
      committed ?? this.git.head(),
      this.git.status(),
      this.artifacts.load(),
    ]);
    const checkpoint = CheckpointSchema.parse({
      schemaVersion: 1,
      checkpointId: randomUUID(),
      runId: this.runId,
      phaseId: input.phaseId,
      beforeCommit: input.beforeCommit,
      afterCommit,
      createdAt: new Date().toISOString(),
      logical: !committed,
      artifactIds: manifest.artifacts
        .filter(
          ({ phaseId, status: artifactStatus }) =>
            phaseId === input.phaseId && artifactStatus === "valid",
        )
        .map(({ artifactId }) => artifactId),
      handoffId: input.handoff?.handoffId,
      gateDecision: input.gateDecision,
      changedFiles: beforeStatus.files.map(({ path }) => path),
      clean: status.clean,
    });
    await atomicJson(this.path(checkpoint.checkpointId), checkpoint);
    if (this.events) {
      await this.events.append(this.runId, {
        type: "checkpoint.recorded",
        actor: { type: "service", id: "swf" },
        context: { phaseId: input.phaseId },
        data: { checkpoint },
      });
    }
    return checkpoint;
  }

  async read(checkpointId: string): Promise<Checkpoint> {
    return CheckpointSchema.parse(
      JSON.parse(await readFile(this.path(checkpointId), "utf8")),
    );
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const entries = await (
        await import("node:fs/promises")
      ).readdir(this.directory());
      return Promise.all(
        entries
          .filter((name) => name.endsWith(".json"))
          .map((name) => this.read(name.slice(0, -5))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async rollback(input: {
    checkpointId: string;
    phaseId: string;
    invalidatedPhaseIds: string[];
    invalidatedArtifactIds: string[];
    authorized: boolean;
  }): Promise<Checkpoint> {
    if (!input.authorized)
      throw new Error("Rollback requires explicit authorization");
    const checkpoint = await this.read(input.checkpointId);
    if (checkpoint.phaseId !== input.phaseId)
      throw new Error("Rollback phase does not match checkpoint");
    const attemptId = randomUUID();
    if (this.events) {
      await this.events.append(this.runId, {
        type: "attempt.started",
        actor: { type: "user", id: "operator" },
        context: { phaseId: input.phaseId, attemptId },
        data: {
          attemptId,
          phaseId: input.phaseId,
          number: 1,
          kind: "rollback",
        },
      });
    }
    await this.git.reset(checkpoint.afterCommit, { clean: true });
    await this.artifacts.invalidateForRunMutation({
      kind: "rollback",
      artifactIds: input.invalidatedArtifactIds,
    });
    if (this.events) {
      await this.events.append(this.runId, {
        type: "run.rolled-back",
        actor: { type: "user", id: "operator" },
        context: { phaseId: input.phaseId, attemptId },
        data: {
          checkpointId: checkpoint.checkpointId,
          phaseId: input.phaseId,
          attemptId,
          invalidatedPhaseIds: input.invalidatedPhaseIds,
        },
      });
      await this.events.append(this.runId, {
        type: "attempt.completed",
        actor: { type: "service", id: "swf" },
        context: { phaseId: input.phaseId, attemptId },
        data: { attemptId, status: "completed", reason: "Rollback completed" },
      });
    }
    return checkpoint;
  }
}

export interface ChangeDossier {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  rawHistory: "unavailable-in-portable-dossier";
  evidenceManifest: Array<{
    artifactId: string;
    type: string;
    phaseId: string;
    status: string;
    summary?: string;
    outputRef: string;
  }>;
  handoffs: DocumentValue<"handoff">[];
  approvals: DocumentValue<"approval">[];
  checkpoints: Checkpoint[];
  deliveryReferences: DocumentValue<"delivery">[];
  finalReport: string;
}

export async function persistChangeDossier(input: {
  changeRoot: string;
  runId: string;
  artifacts: ArtifactStore;
  handoffs?: DocumentValue<"handoff">[];
  approvals?: DocumentValue<"approval">[];
  checkpoints?: Checkpoint[];
  deliveries?: DocumentValue<"delivery">[];
  finalReport: string;
}): Promise<{ path: string; dossier: ChangeDossier }> {
  const manifest = await input.artifacts.load();
  const dossier: ChangeDossier = {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    rawHistory: "unavailable-in-portable-dossier",
    evidenceManifest: manifest.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      phaseId: artifact.phaseId,
      status: artifact.status,
      summary: artifact.summary
        ? redactPortableText(artifact.summary)
        : undefined,
      outputRef: artifact.outputRef,
    })),
    handoffs: (input.handoffs ?? []).map(portableHandoff),
    approvals: (input.approvals ?? []).map((approval) => ({
      ...approval,
      reason: approval.reason ? redactPortableText(approval.reason) : undefined,
    })),
    checkpoints: input.checkpoints ?? [],
    deliveryReferences: input.deliveries ?? [],
    finalReport: redactPortableText(input.finalReport).slice(0, 10_000),
  };
  const path = join(input.changeRoot, "evidence", "dossier.json");
  await atomicJson(path, dossier);
  return { path, dossier };
}

export async function validateChangeDossier(
  changeRoot: string,
): Promise<ChangeDossier> {
  const value = JSON.parse(
    await readFile(join(changeRoot, "evidence", "dossier.json"), "utf8"),
  ) as ChangeDossier;
  if (
    value.schemaVersion !== 1 ||
    !value.runId ||
    !Array.isArray(value.evidenceManifest)
  )
    throw new Error("Invalid portable change dossier");
  if (JSON.stringify(value).includes("raw/"))
    throw new Error(
      "Portable change dossier must not contain raw-output references",
    );
  return value;
}

/** Validates the change through OpenSpec after writing its evidence subtree. */
export async function validateDossierWithOpenSpec(input: {
  runner: CommandRunner;
  changeName: string;
  cwd: string;
}): Promise<void> {
  const result = await input.runner.run(
    "openspec",
    ["validate", input.changeName],
    { cwd: input.cwd },
  );
  if (result.code !== 0)
    throw new Error(
      `OpenSpec rejected change evidence: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}
