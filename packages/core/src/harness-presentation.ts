import { z } from "zod";
import { Redactor } from "./security.js";
import type { HarnessEvent } from "./harness-events.js";

export const HarnessPresentationLevelSchema = z.enum([
  "quiet",
  "normal",
  "verbose",
  "protocol",
]);
export type HarnessPresentationLevel = z.infer<
  typeof HarnessPresentationLevelSchema
>;
export const HarnessPresentationConfigSchema = z.object({
  schemaVersion: z.literal(1),
  level: HarnessPresentationLevelSchema.default("normal"),
  maxTextLength: z.number().int().positive().max(16_384).default(512),
  maxToolLength: z.number().int().positive().max(16_384).default(240),
});
export type HarnessPresentationConfig = z.infer<
  typeof HarnessPresentationConfigSchema
>;

export function resolveHarnessPresentation(input: {
  invocation?: Partial<HarnessPresentationConfig>;
  phase?: Partial<HarnessPresentationConfig>;
  project?: Partial<HarnessPresentationConfig>;
}): {
  value: HarnessPresentationConfig;
  source: "invocation" | "phase" | "project" | "default";
} {
  const source = input.invocation?.level
    ? "invocation"
    : input.phase?.level
      ? "phase"
      : input.project?.level
        ? "project"
        : "default";
  return {
    source,
    value: HarnessPresentationConfigSchema.parse({
      schemaVersion: 1,
      ...input.project,
      ...input.phase,
      ...input.invocation,
    }),
  };
}

function bounded(value: unknown, limit: number, redactor: Redactor): string {
  const text = redactor.text(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 18)}… [inspect retained]`;
}

function toolSummary(
  event: HarnessEvent,
  limit: number,
  redactor: Redactor,
): string {
  const tool = String(event.data.tool ?? event.data.name ?? "tool");
  const lower = tool.toLowerCase();
  const verb = lower.includes("read")
    ? "Read"
    : lower.includes("write")
      ? "Wrote"
      : lower.includes("edit")
        ? "Edited"
        : lower.includes("shell") ||
            lower.includes("bash") ||
            lower.includes("command")
          ? "Ran"
          : lower.includes("search") || lower.includes("find")
            ? "Searched"
            : lower.includes("test") ||
                lower.includes("lint") ||
                lower.includes("valid")
              ? "Validated"
              : "Used";
  return `${verb} ${bounded(event.data.path ?? event.data.summary ?? tool, limit, redactor)}`;
}

export class HarnessPaneRenderer {
  readonly config: HarnessPresentationConfig;
  private readonly seen = new Set<string>();
  constructor(
    config: Partial<HarnessPresentationConfig> = {},
    readonly redactor = new Redactor(),
  ) {
    this.config = HarnessPresentationConfigSchema.parse({
      schemaVersion: 1,
      ...config,
    });
  }

  render(event: HarnessEvent, nativeRecord?: unknown): string | undefined {
    if (this.seen.has(event.eventId)) return undefined;
    this.seen.add(event.eventId);
    const { level, maxTextLength, maxToolLength } = this.config;
    if (level === "protocol")
      return `⚠ protocol mode: redacted machine output may be sensitive\n${bounded(nativeRecord ?? event.data, maxTextLength, this.redactor)}`;
    if (event.type === "processStarted")
      return `${event.phaseId} · ${event.harness} · ${event.runId}`;
    if (event.type === "blocked")
      return `! Input required: ${bounded(event.data.prompt, maxTextLength, this.redactor)}`;
    if (event.type === "failed")
      return `✗ Failed: ${bounded(event.data.summary ?? event.data.message, maxTextLength, this.redactor)}`;
    if (event.type === "cancelled") return "– Cancelled";
    if (event.type === "settled" || event.type === "completed") {
      const duration = event.data.durationMs
        ? ` in ${Math.round(Number(event.data.durationMs) / 1000)}s`
        : "";
      const tokens =
        event.usage?.totalTokens !== undefined
          ? ` · ${event.usage.totalTokens.toLocaleString()} tokens`
          : "";
      const cost =
        event.usage?.costUsd !== undefined
          ? ` · $${event.usage.costUsd.toFixed(3)}`
          : "";
      return `✓ Completed${duration}${tokens}${cost}`;
    }
    if (level === "quiet") return undefined;
    if (event.type === "ready") return "  Ready";
    if (event.type === "workStarted") return "  Working";
    if (event.type === "retryStarted") return "  ↻ Retrying";
    if (event.type === "compactionStarted") return "  ↻ Compacting context";
    if (["toolStarted", "toolCompleted"].includes(event.type))
      return `  ${event.type === "toolCompleted" ? "✓" : "•"} ${toolSummary(event, maxToolLength, this.redactor)}`;
    if (
      level === "verbose" &&
      ["messageSummary", "toolProgress", "diagnostic"].includes(event.type)
    )
      return `  ${bounded(event.data.summary ?? event.data.message, maxTextLength, this.redactor)}`;
    return undefined;
  }
}

export function harnessPaneLabel(input: {
  runId: string;
  phaseId: string;
  harness: string;
  status?: string;
}): string {
  return [
    input.runId,
    input.phaseId,
    input.harness,
    input.status ?? "starting",
  ].join(" · ");
}
