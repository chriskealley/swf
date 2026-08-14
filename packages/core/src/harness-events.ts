import { createHash } from "node:crypto";
import { z } from "zod";

export const HarnessEventTypeSchema = z.enum([
  "processStarted",
  "ready",
  "promptAccepted",
  "workStarted",
  "messageSummary",
  "toolStarted",
  "toolProgress",
  "toolCompleted",
  "blocked",
  "usage",
  "retryStarted",
  "retryCompleted",
  "compactionStarted",
  "compactionCompleted",
  "completed",
  "settled",
  "cancelled",
  "failed",
  "diagnostic",
]);
export type HarnessEventType = z.infer<typeof HarnessEventTypeSchema>;

export const HarnessCorrelationSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  phaseId: z.string().min(1),
  workUnitId: z.string().min(1),
  invocationId: z.string().min(1),
  harness: z.string().min(1),
  nativeSessionId: z.string().min(1).optional(),
});

export const HarnessUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  quality: z.enum(["exact", "estimated", "unknown"]),
});

export const HarnessEventSchema = HarnessCorrelationSchema.extend({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sourceCursor: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  type: HarnessEventTypeSchema,
  required: z.boolean().default(false),
  sequence: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).default({}),
  usage: HarnessUsageSchema.optional(),
});
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessCorrelation = z.infer<typeof HarnessCorrelationSchema>;

export interface NativeRecord {
  cursor: string;
  identity: string;
  value: Record<string, unknown>;
  raw: string;
}

export interface HarnessCodecCapabilities {
  blockedInput: boolean;
  bidirectional: boolean;
  resume: boolean;
  exactUsage: boolean;
}

export interface HarnessCodec {
  readonly harness: string;
  readonly version: string;
  readonly capabilities: HarnessCodecCapabilities;
  frame(
    chunk: Uint8Array,
    end?: boolean,
  ): {
    records: string[];
    remainder: Uint8Array;
    trailingPartial?: string;
  };
  parse(record: string, cursor: string): NativeRecord;
  normalize(record: NativeRecord, context: HarnessCorrelation): HarnessEvent[];
  isRequiredNativeType(type: string): boolean;
}

export function nativeEventIdentity(input: {
  harness: string;
  invocationId: string;
  cursor: string;
  value: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function normalizedEvent(
  input: Omit<HarnessEvent, "schemaVersion" | "eventId">,
): HarnessEvent {
  return HarnessEventSchema.parse({
    ...input,
    schemaVersion: 1,
    eventId: createHash("sha256")
      .update(
        `${input.invocationId}:${input.sourceCursor}:${input.type}:${input.sequence}`,
      )
      .digest("hex"),
  });
}

export interface HarnessInvocationState {
  status:
    | "pending"
    | "ready"
    | "running"
    | "blocked"
    | "completed"
    | "settled"
    | "cancelled"
    | "failed";
  seenEventIds: Set<string>;
  lastSequence: number;
  nativeSessionId?: string;
  blockedPrompt?: string;
  usage?: z.infer<typeof HarnessUsageSchema>;
  diagnostics: string[];
}

export function initialHarnessInvocationState(): HarnessInvocationState {
  return {
    status: "pending",
    seenEventIds: new Set(),
    lastSequence: -1,
    diagnostics: [],
  };
}

export function reduceHarnessEvent(
  state: HarnessInvocationState,
  event: HarnessEvent,
): HarnessInvocationState {
  if (state.seenEventIds.has(event.eventId)) return state;
  if (event.sequence < state.lastSequence)
    throw new Error(
      `Out-of-order harness event ${event.eventId}: ${event.sequence} < ${state.lastSequence}`,
    );
  const seenEventIds = new Set(state.seenEventIds).add(event.eventId);
  const next: HarnessInvocationState = {
    ...state,
    seenEventIds,
    lastSequence: event.sequence,
    nativeSessionId: event.nativeSessionId ?? state.nativeSessionId,
    usage: event.usage ?? state.usage,
    diagnostics: [...state.diagnostics],
  };
  switch (event.type) {
    case "ready":
      next.status = "ready";
      break;
    case "workStarted":
    case "retryStarted":
    case "compactionStarted":
      next.status = "running";
      break;
    case "blocked":
      next.status = "blocked";
      next.blockedPrompt = String(event.data.prompt ?? "Agent requires input");
      break;
    case "completed":
      next.status = "completed";
      break;
    case "settled":
      next.status = "settled";
      break;
    case "cancelled":
      next.status = "cancelled";
      break;
    case "failed":
      next.status = "failed";
      break;
    case "diagnostic":
      next.diagnostics.push(String(event.data.message ?? "Harness diagnostic"));
      break;
  }
  return next;
}

export function reduceHarnessEvents(
  events: Iterable<HarnessEvent>,
): HarnessInvocationState {
  let state = initialHarnessInvocationState();
  for (const event of events) state = reduceHarnessEvent(state, event);
  return state;
}
