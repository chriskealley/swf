import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskAuditSchema, type DocumentValue } from "./schemas.js";
import type { Artifact } from "./domain.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CheckEvidence, AgentReview } from "./checks.js";

export type TaskAudit = DocumentValue<"taskAudit">;
export type TaskAuditEntry = TaskAudit["entries"][number];

export interface ParsedTask extends TaskAuditEntry {
  line: number;
}

export function normalizeTaskText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseOpenSpecTasks(contents: string): ParsedTask[] {
  const entries: ParsedTask[] = [];
  let section = "tasks";
  let ordinal = 0;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) section = normalizeTaskText(heading[1]!);
    const task = line.match(/^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!task) continue;
    ordinal += 1;
    const text = normalizeTaskText(task[2]!);
    const numeric = text.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const taskId = numeric?.[1] ?? `${ordinal}`;
    entries.push({
      taskId: `${taskId}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`,
      text: `${section}: ${text}`,
      checked: task[1]!.toLowerCase() === "x",
      implementationRefs: [],
      checkIds: [],
      evidenceFresh: false,
      reviewBlockers: [],
      conclusion: "unverified",
      line: index + 1,
    });
  }
  return entries;
}

export function buildTaskAudit(input: {
  tasksContents: string;
  tasksPath: string;
  sourceCommit: string;
  implementationRefs?: string[];
  checks?: CheckEvidence[];
  review?: AgentReview;
  reviewResolutions?: Array<{
    findingId: string;
    status: "open" | "resolved" | "waived";
    evidenceArtifactIds?: string[];
    sourceCommit?: string;
  }>;
}): TaskAudit {
  const parsed = parseOpenSpecTasks(input.tasksContents);
  const checks = input.checks ?? [];
  const failedChecks = checks
    .filter((check) => check.required && check.status !== "passed")
    .map(({ checkId }) => checkId);
  const resolutions = new Map(
    (input.reviewResolutions ?? []).map((resolution) => [
      resolution.findingId,
      resolution,
    ]),
  );
  const reviewBlockers = (input.review?.findings ?? [])
    .filter(({ severity }) => severity === "blocking")
    .filter(({ id }) => {
      const resolution = resolutions.get(id);
      return (
        !resolution ||
        resolution.status === "open" ||
        resolution.sourceCommit !== input.sourceCommit ||
        !resolution.evidenceArtifactIds?.length
      );
    })
    .map(({ id }) => id);
  const refs = input.implementationRefs ?? [];
  const entries = parsed.map((task) => {
    const evidenceFresh = checks.every(
      (check) =>
        !check.artifact || check.artifact.sourceCommit === input.sourceCommit,
    );
    const reasons: string[] = [];
    if (!task.checked) reasons.push("task checkbox is incomplete");
    if (!refs.length) reasons.push("no implementation reference was supplied");
    if (!evidenceFresh) reasons.push("verification evidence is stale");
    if (failedChecks.length)
      reasons.push(
        `required checks failed or are incomplete: ${failedChecks.join(", ")}`,
      );
    if (reviewBlockers.length)
      reasons.push(
        `blocking review findings remain: ${reviewBlockers.join(", ")}`,
      );
    const conclusion = reasons.length ? "unverified" : "verified";
    return {
      taskId: task.taskId,
      text: task.text,
      checked: task.checked,
      implementationRefs: refs,
      checkIds: checks.map(({ checkId }) => checkId),
      evidenceFresh,
      reviewBlockers,
      conclusion,
      ...(reasons.length ? { reason: reasons.join("; ") } : {}),
    } satisfies TaskAuditEntry;
  });
  const status =
    entries.length === 0
      ? "failed"
      : entries.every(({ conclusion }) => conclusion === "verified")
        ? "verified"
        : entries.some(({ checked }) => !checked) ||
            failedChecks.length ||
            reviewBlockers.length
          ? "failed"
          : "blocked";
  const summary =
    status === "verified"
      ? `Verified ${entries.length} OpenSpec task(s) against ${input.sourceCommit}`
      : `${entries.filter(({ conclusion }) => conclusion !== "verified").length} OpenSpec task(s) remain unverified`;
  return TaskAuditSchema.parse({
    schemaVersion: 1,
    sourceCommit: input.sourceCommit,
    tasksPath: input.tasksPath,
    entries,
    status,
    summary,
  });
}

export async function auditOpenSpecTasks(input: {
  changeRoot: string;
  sourceCommit: string;
  implementationRefs?: string[];
  checks?: CheckEvidence[];
  review?: AgentReview;
  reviewResolutions?: Array<{
    findingId: string;
    status: "open" | "resolved" | "waived";
    evidenceArtifactIds?: string[];
    sourceCommit?: string;
  }>;
}): Promise<TaskAudit> {
  const tasksPath = join(input.changeRoot, "tasks.md");
  return buildTaskAudit({
    tasksContents: await readFile(tasksPath, "utf8"),
    tasksPath,
    sourceCommit: input.sourceCommit,
    implementationRefs: input.implementationRefs,
    checks: input.checks,
    review: input.review,
    reviewResolutions: input.reviewResolutions,
  });
}

export async function recordTaskAudit(input: {
  artifacts: ArtifactStore;
  phaseId: string;
  audit: TaskAudit;
}): Promise<Artifact> {
  const artifactId = randomUUID();
  const outputRef = `artifacts/${artifactId}.json`;
  await input.artifacts.retainRaw(
    `task-audits/${artifactId}.json`,
    `${JSON.stringify(input.audit, null, 2)}\n`,
  );
  const artifact: Artifact = {
    schemaVersion: 1,
    artifactId,
    runId: input.artifacts.runId,
    type: "task-audit",
    phaseId: input.phaseId,
    sourceCommit: input.audit.sourceCommit,
    inputFingerprint: createHash("sha256")
      .update(JSON.stringify(input.audit.entries))
      .digest("hex"),
    status: input.audit.status === "verified" ? "valid" : "invalid",
    createdAt: new Date().toISOString(),
    outputRef,
    summary: input.audit.summary,
    consumers: [],
  };
  await input.artifacts.record(artifact);
  return artifact;
}
