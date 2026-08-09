import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HandoffSchema, type DocumentValue } from "./schemas.js";
import type { Artifact } from "./domain.js";
import type { GitClient, GitStatus } from "./git.js";
import { Redactor, type RedactionOptions } from "./security.js";

export interface ArtifactManifest {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  artifacts: Artifact[];
}

export interface DeterministicCommandResult {
  command: string;
  configurationFingerprint: string;
  commit: string;
  exitCode: number;
  summary: string;
  rawOutputRef: string;
}

export interface GitEvidence {
  beforeCommit: string;
  afterCommit: string;
  status: GitStatus;
  diffRef: string;
  changedFiles: string[];
  clean: boolean;
}

export interface OpenSpecEvidence {
  status: "valid" | "invalid";
  summary: string;
  rawOutputRef: string;
}

export interface ArtifactContext {
  openspec: string[];
  evidence: Array<
    Pick<Artifact, "artifactId" | "type" | "phaseId" | "outputRef">
  >;
  handoffs: Array<DocumentValue<"handoff">>;
  rawOutputRefs: string[];
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedSummary(value: string, limit = 2_000): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}\n… [truncated; see raw output]`;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class ArtifactStore {
  readonly redactor: Redactor;

  constructor(
    readonly stateDirectory: string,
    readonly runId: string,
    redaction: RedactionOptions | Redactor = {},
  ) {
    this.redactor =
      redaction instanceof Redactor ? redaction : new Redactor(redaction);
  }

  private runDirectory(): string {
    return join(this.stateDirectory, "runs", this.runId);
  }
  private manifestPath(): string {
    return join(this.runDirectory(), "artifacts", "manifest.json");
  }
  private rawPath(name: string): string {
    return join(this.runDirectory(), "raw", name);
  }

  async load(): Promise<ArtifactManifest> {
    try {
      const value = JSON.parse(
        await readFile(this.manifestPath(), "utf8"),
      ) as ArtifactManifest;
      if (
        value.schemaVersion !== 1 ||
        value.runId !== this.runId ||
        !Array.isArray(value.artifacts)
      )
        throw new Error("Invalid artifact manifest");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          schemaVersion: 1,
          runId: this.runId,
          updatedAt: new Date().toISOString(),
          artifacts: [],
        };
      throw error;
    }
  }

  async record(artifact: Artifact): Promise<Artifact> {
    if (artifact.runId !== this.runId)
      throw new Error("Artifact belongs to another run");
    const retained = this.redactor.value(artifact);
    const manifest = await this.load();
    const index = manifest.artifacts.findIndex(
      ({ artifactId }) => artifactId === retained.artifactId,
    );
    if (index >= 0) manifest.artifacts[index] = retained;
    else manifest.artifacts.push(retained);
    manifest.updatedAt = new Date().toISOString();
    await atomicJson(this.manifestPath(), this.redactor.value(manifest));
    return retained;
  }

  async retainRaw(name: string, output: string): Promise<string> {
    const reference = `raw/${name}`;
    await mkdir(dirname(this.rawPath(name)), { recursive: true, mode: 0o700 });
    await writeFile(this.rawPath(name), this.redactor.text(output), {
      mode: 0o600,
    });
    return reference;
  }

  async markRawOutputPruned(
    reference: string,
    prunedAt = new Date().toISOString(),
  ): Promise<Artifact[]> {
    const manifest = await this.load();
    const affected = manifest.artifacts.filter(
      (artifact) => artifact.rawOutputRef === reference,
    );
    for (const artifact of affected) {
      artifact.rawOutputAvailable = false;
      artifact.rawOutputPrunedAt = prunedAt;
      artifact.rawOutputUnavailableReason = "retention-policy";
    }
    if (affected.length) {
      manifest.updatedAt = prunedAt;
      await atomicJson(this.manifestPath(), manifest);
    }
    return affected;
  }

  async captureCommand(input: {
    phaseId: string;
    attemptId?: string;
    command: string;
    configuration: unknown;
    commit: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }): Promise<{ artifact: Artifact; result: DeterministicCommandResult }> {
    const artifactId = randomUUID();
    const configurationFingerprint = fingerprint({
      command: input.command,
      configuration: input.configuration,
    });
    const rawOutputRef = await this.retainRaw(
      `commands/${artifactId}.log`,
      `${input.stdout}${input.stderr ? `\n${input.stderr}` : ""}`,
    );
    const result: DeterministicCommandResult = {
      command: input.command,
      configurationFingerprint,
      commit: input.commit,
      exitCode: input.exitCode,
      summary:
        boundedSummary(
          `${input.stdout}${input.stderr ? `\n${input.stderr}` : ""}`,
        ) || `Command exited with status ${input.exitCode}`,
      rawOutputRef,
    };
    const outputRef = `artifacts/${artifactId}.json`;
    await atomicJson(
      join(this.runDirectory(), outputRef),
      this.redactor.value(result),
    );
    const artifact: Artifact = {
      schemaVersion: 1,
      artifactId,
      runId: this.runId,
      type: "command-result",
      phaseId: input.phaseId,
      sourceCommit: input.commit,
      inputFingerprint: configurationFingerprint,
      status: input.exitCode === 0 ? "valid" : "invalid",
      createdAt: new Date().toISOString(),
      outputRef,
      producerAttemptId: input.attemptId,
      rawOutputRef,
      summary: result.summary,
      consumers: [],
    };
    await this.record(artifact);
    return { artifact, result };
  }

  async captureGitEvidence(input: {
    phaseId: string;
    attemptId?: string;
    beforeCommit: string;
    git: GitClient;
  }): Promise<{ artifact: Artifact; evidence: GitEvidence }> {
    const [status, afterCommit, diff] = await Promise.all([
      input.git.status(),
      input.git.head(),
      input.git.diff(input.beforeCommit),
    ]);
    const artifactId = randomUUID();
    const diffRef = await this.retainRaw(`git/${artifactId}.diff`, diff);
    const evidence: GitEvidence = {
      beforeCommit: input.beforeCommit,
      afterCommit,
      status,
      diffRef,
      changedFiles: status.files.map(({ path }) => path),
      clean: status.clean,
    };
    const outputRef = `artifacts/${artifactId}.json`;
    await atomicJson(
      join(this.runDirectory(), outputRef),
      this.redactor.value(evidence),
    );
    const artifact: Artifact = {
      schemaVersion: 1,
      artifactId,
      runId: this.runId,
      type: "git-evidence",
      phaseId: input.phaseId,
      sourceCommit: afterCommit,
      inputFingerprint: fingerprint({ beforeCommit: input.beforeCommit }),
      status: "valid",
      createdAt: new Date().toISOString(),
      outputRef,
      producerAttemptId: input.attemptId,
      rawOutputRef: diffRef,
      summary: boundedSummary(
        `Changed files: ${evidence.changedFiles.join(", ") || "none"}`,
      ),
      consumers: [],
    };
    await this.record(artifact);
    return { artifact, evidence };
  }

  async captureOpenSpecEvidence(input: {
    phaseId: string;
    attemptId?: string;
    commit: string;
    command: string;
    exitCode: number;
    output: string;
  }): Promise<{ artifact: Artifact; evidence: OpenSpecEvidence }> {
    const artifactId = randomUUID();
    const rawOutputRef = await this.retainRaw(
      `openspec/${artifactId}.log`,
      input.output,
    );
    const evidence: OpenSpecEvidence = {
      status: input.exitCode === 0 ? "valid" : "invalid",
      summary:
        boundedSummary(input.output) ||
        `OpenSpec validation ${input.exitCode === 0 ? "passed" : "failed"}`,
      rawOutputRef,
    };
    const outputRef = `artifacts/${artifactId}.json`;
    await atomicJson(
      join(this.runDirectory(), outputRef),
      this.redactor.value({
        command: input.command,
        ...evidence,
      }),
    );
    const artifact: Artifact = {
      schemaVersion: 1,
      artifactId,
      runId: this.runId,
      type: "openspec-validation",
      phaseId: input.phaseId,
      sourceCommit: input.commit,
      inputFingerprint: fingerprint({ command: input.command }),
      status: evidence.status,
      createdAt: new Date().toISOString(),
      outputRef,
      producerAttemptId: input.attemptId,
      rawOutputRef,
      summary: evidence.summary,
      consumers: [],
    };
    await this.record(artifact);
    return { artifact, evidence };
  }

  async retainHandoff(handoff: DocumentValue<"handoff">): Promise<string> {
    if (handoff.runId !== this.runId)
      throw new Error("Handoff belongs to another run");
    const reference = `artifacts/handoffs/${handoff.handoffId}.json`;
    await atomicJson(
      join(this.runDirectory(), reference),
      this.redactor.value(handoff),
    );
    return reference;
  }

  async reusable(
    command: string,
    configuration: unknown,
    commit: string,
  ): Promise<Artifact | undefined> {
    const key = fingerprint({ command, configuration });
    return (await this.load()).artifacts.find(
      (artifact) =>
        artifact.type === "command-result" &&
        artifact.status === "valid" &&
        artifact.sourceCommit === commit &&
        artifact.inputFingerprint === key,
    );
  }

  async consume(artifactId: string, phaseId: string): Promise<void> {
    const manifest = await this.load();
    const artifact = manifest.artifacts.find(
      (entry) => entry.artifactId === artifactId,
    );
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    artifact.consumers = [...new Set([...(artifact.consumers ?? []), phaseId])];
    manifest.updatedAt = new Date().toISOString();
    await atomicJson(this.manifestPath(), manifest);
  }

  async invalidateForSourceChange(
    commit: string,
    reason = "source changed",
  ): Promise<Artifact[]> {
    const manifest = await this.load();
    const changed = manifest.artifacts.filter(
      (artifact) =>
        artifact.sourceCommit !== commit && artifact.status === "valid",
    );
    for (const artifact of changed) {
      artifact.status = "stale";
      artifact.invalidReason = reason;
    }
    if (changed.length) {
      manifest.updatedAt = new Date().toISOString();
      await atomicJson(this.manifestPath(), manifest);
    }
    return changed;
  }

  async invalidateForRunMutation(input: {
    kind: "source-change" | "remediation" | "reset" | "rollback";
    commit?: string;
    artifactIds?: string[];
  }): Promise<Artifact[]> {
    const reason = `${input.kind.replaceAll("-", " ")}`;
    if (input.kind === "source-change" && input.commit)
      return this.invalidateForSourceChange(input.commit, reason);
    const ids =
      input.artifactIds ??
      (await this.load()).artifacts.map(({ artifactId }) => artifactId);
    return this.invalidateArtifacts(ids, reason);
  }

  async invalidateArtifacts(
    artifactIds: string[],
    reason: string,
  ): Promise<Artifact[]> {
    const manifest = await this.load();
    const changed = manifest.artifacts.filter(
      (artifact) =>
        artifactIds.includes(artifact.artifactId) &&
        artifact.status !== "invalid",
    );
    for (const artifact of changed) {
      artifact.status = "invalid";
      artifact.invalidReason = reason;
    }
    if (changed.length) {
      manifest.updatedAt = new Date().toISOString();
      await atomicJson(this.manifestPath(), manifest);
    }
    return changed;
  }

  async selectContext(input: {
    openspec?: string[];
    handoffs?: DocumentValue<"handoff">[];
    phaseIds?: string[];
    includeRawOutput?: boolean;
  }): Promise<ArtifactContext> {
    const artifacts = (await this.load()).artifacts.filter(
      (artifact) =>
        artifact.status === "valid" &&
        (!input.phaseIds || input.phaseIds.includes(artifact.phaseId)),
    );
    return {
      openspec: input.openspec ?? [],
      evidence: artifacts.map(({ artifactId, type, phaseId, outputRef }) => ({
        artifactId,
        type,
        phaseId,
        outputRef,
      })),
      handoffs: input.handoffs ?? [],
      rawOutputRefs: input.includeRawOutput
        ? artifacts.flatMap(({ rawOutputRef }) =>
            rawOutputRef ? [rawOutputRef] : [],
          )
        : [],
    };
  }
}

export interface HandoffRequest {
  facts: ArtifactContext;
  prompt: string;
}
export interface HandoffAgent {
  requestHandoff(request: HandoffRequest): Promise<unknown>;
}

export async function requestStructuredHandoff(input: {
  runId: string;
  phaseId: string;
  agent?: HandoffAgent;
  facts: ArtifactContext;
  retries?: number;
}): Promise<DocumentValue<"handoff">> {
  const fallback = (): DocumentValue<"handoff"> =>
    HandoffSchema.parse({
      schemaVersion: 1,
      handoffId: randomUUID(),
      runId: input.runId,
      phaseId: input.phaseId,
      summary: ["Deterministic evidence collected; agent handoff unavailable."],
      decisions: [],
      knownIssues: ["Narrative handoff unavailable"],
      recommendedNextActions: ["Review deterministic evidence summaries"],
      artifactIds: input.facts.evidence.map(({ artifactId }) => artifactId),
      degraded: true,
    });
  if (!input.agent) return fallback();
  for (let attempt = 0; attempt <= (input.retries ?? 1); attempt += 1) {
    try {
      const candidate = await input.agent.requestHandoff({
        facts: input.facts,
        prompt:
          "Return only the structured phase handoff based on these deterministic facts.",
      });
      const handoff = HandoffSchema.parse(candidate);
      if (handoff.runId !== input.runId || handoff.phaseId !== input.phaseId)
        throw new Error("Handoff belongs to another phase");
      return handoff;
    } catch {
      /* retry or fall back */
    }
  }
  return fallback();
}
