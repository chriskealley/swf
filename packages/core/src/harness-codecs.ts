import {
  nativeEventIdentity,
  normalizedEvent,
  type HarnessCodec,
  type HarnessCorrelation,
  type HarnessEvent,
  type HarnessEventType,
  type NativeRecord,
} from "./harness-events.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** LF-only framing: U+2028/U+2029 remain ordinary JSON string content. */
export function frameLf(
  chunk: Uint8Array,
  previous = new Uint8Array(),
  end = false,
) {
  const bytes = new Uint8Array(previous.length + chunk.length);
  bytes.set(previous);
  bytes.set(chunk, previous.length);
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let finish = index;
    if (finish > start && bytes[finish - 1] === 0x0d) finish -= 1;
    records.push(decoder.decode(bytes.slice(start, finish)));
    start = index + 1;
  }
  const remainder = bytes.slice(start);
  return {
    records: records.filter(Boolean),
    remainder: end ? new Uint8Array() : remainder,
    trailingPartial:
      end && remainder.length
        ? decoder.decode(remainder.slice(0, 4096))
        : undefined,
  };
}

function recordType(value: Record<string, unknown>): string {
  return String(
    value.type ?? value.event ?? value.kind ?? value.method ?? "unknown",
  );
}

function nested(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function usageOf(
  value: Record<string, unknown>,
  quality: "exact" | "estimated",
) {
  const usage =
    nested(value.usage) ??
    nested(nested(value.message)?.usage) ??
    nested(nested(value.result)?.usage);
  if (!usage) return undefined;
  const inputTokens = number(
    usage.input_tokens ?? usage.inputTokens ?? usage.input,
  );
  const outputTokens = number(
    usage.output_tokens ?? usage.outputTokens ?? usage.output,
  );
  const totalTokens =
    number(usage.total_tokens ?? usage.totalTokens ?? usage.total) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const costUsd = number(
    usage.cost_usd ?? usage.costUsd ?? value.total_cost_usd,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    quality:
      totalTokens === undefined && costUsd === undefined
        ? ("unknown" as const)
        : quality,
  };
}

function textOf(value: Record<string, unknown>): string | undefined {
  const candidates = [
    value.summary,
    value.text,
    value.message,
    nested(value.message)?.content,
    value.result,
    value.error,
  ];
  return candidates.find((entry): entry is string => typeof entry === "string");
}

abstract class JsonlCodec implements HarnessCodec {
  abstract readonly harness: string;
  abstract readonly version: string;
  abstract readonly capabilities: HarnessCodec["capabilities"];
  protected remainder = new Uint8Array();

  frame(chunk: Uint8Array, end = false) {
    const framed = frameLf(chunk, this.remainder, end);
    this.remainder = framed.remainder;
    return framed;
  }

  parse(raw: string, cursor: string): NativeRecord {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Native harness record must be a JSON object");
    return {
      cursor,
      value: value as Record<string, unknown>,
      raw,
      identity: nativeEventIdentity({
        harness: this.harness,
        invocationId: "native",
        cursor,
        value,
      }),
    };
  }

  abstract normalize(
    record: NativeRecord,
    context: HarnessCorrelation,
  ): HarnessEvent[];
  abstract isRequiredNativeType(type: string): boolean;

  protected event(
    record: NativeRecord,
    context: HarnessCorrelation,
    type: HarnessEventType,
    data: Record<string, unknown> = {},
    required = false,
  ): HarnessEvent {
    const nativeSessionId = [
      record.value.session_id,
      record.value.sessionId,
      record.value.thread_id,
      record.value.threadId,
    ].find((value): value is string => typeof value === "string");
    return normalizedEvent({
      ...context,
      nativeSessionId: nativeSessionId ?? context.nativeSessionId,
      sourceCursor: record.cursor,
      timestamp: new Date().toISOString(),
      type,
      required,
      sequence: Number.parseInt(record.cursor, 10) || 0,
      data,
    });
  }
}

export class PiRpcCodec extends JsonlCodec {
  readonly harness = "pi";
  readonly version = "pi-rpc-v1";
  readonly capabilities = {
    blockedInput: true,
    bidirectional: true,
    resume: false,
    exactUsage: true,
  };
  isRequiredNativeType(type: string) {
    return ["agent_start", "agent_settled", "error"].includes(type);
  }
  normalize(record: NativeRecord, context: HarnessCorrelation): HarnessEvent[] {
    const type = recordType(record.value);
    const data = { nativeType: type, summary: textOf(record.value) };
    if (["response", "prompt_accepted"].includes(type))
      return [this.event(record, context, "promptAccepted", data)];
    if (["agent_start", "turn_start"].includes(type))
      return [this.event(record, context, "workStarted", data, true)];
    if (["message_update", "message_end", "assistant_message"].includes(type))
      return [this.event(record, context, "messageSummary", data)];
    if (["tool_execution_start", "tool_start"].includes(type))
      return [
        this.event(record, context, "toolStarted", {
          ...data,
          tool: record.value.toolName ?? record.value.tool_name,
        }),
      ];
    if (["tool_execution_update", "tool_update"].includes(type))
      return [this.event(record, context, "toolProgress", data)];
    if (["tool_execution_end", "tool_end"].includes(type))
      return [this.event(record, context, "toolCompleted", data)];
    if (["extension_ui_request", "blocked", "input_required"].includes(type))
      return [
        this.event(record, context, "blocked", {
          ...data,
          prompt: textOf(record.value),
        }),
      ];
    if (type.includes("retry") && type.includes("start"))
      return [this.event(record, context, "retryStarted", data)];
    if (type.includes("retry"))
      return [this.event(record, context, "retryCompleted", data)];
    if (type.includes("compaction") && type.includes("start"))
      return [this.event(record, context, "compactionStarted", data)];
    if (type.includes("compaction"))
      return [this.event(record, context, "compactionCompleted", data)];
    if (["agent_end", "turn_end"].includes(type))
      return [this.event(record, context, "completed", data)];
    if (type === "agent_settled")
      return [this.event(record, context, "settled", data, true)];
    if (["abort", "cancelled"].includes(type))
      return [this.event(record, context, "cancelled", data)];
    if (["error", "failed"].includes(type))
      return [this.event(record, context, "failed", data, true)];
    const usage = usageOf(record.value, "exact");
    return usage
      ? [{ ...this.event(record, context, "usage", data), usage }]
      : [];
  }
}

export class ClaudeStreamJsonCodec extends JsonlCodec {
  readonly harness = "claude";
  readonly version = "claude-stream-json-v1";
  readonly capabilities = {
    blockedInput: false,
    bidirectional: false,
    resume: true,
    exactUsage: false,
  };
  isRequiredNativeType(type: string) {
    return ["system", "result", "error"].includes(type);
  }
  normalize(record: NativeRecord, context: HarnessCorrelation): HarnessEvent[] {
    const type = recordType(record.value);
    const data = { nativeType: type, summary: textOf(record.value) };
    if (type === "system")
      return [this.event(record, context, "ready", data, true)];
    if (type === "assistant")
      return [this.event(record, context, "messageSummary", data)];
    if (["tool_use", "tool_start"].includes(type))
      return [this.event(record, context, "toolStarted", data)];
    if (["tool_result", "tool_end"].includes(type))
      return [this.event(record, context, "toolCompleted", data)];
    if (type === "result") {
      const usage = usageOf(record.value, "estimated");
      const terminal = record.value.is_error === true ? "failed" : "settled";
      return [{ ...this.event(record, context, terminal, data, true), usage }];
    }
    if (type === "error")
      return [this.event(record, context, "failed", data, true)];
    return [];
  }
}

export class CodexJsonlCodec extends JsonlCodec {
  readonly harness = "codex";
  readonly version = "codex-jsonl-v1";
  readonly capabilities = {
    blockedInput: false,
    bidirectional: false,
    resume: true,
    exactUsage: true,
  };
  isRequiredNativeType(type: string) {
    return ["thread.started", "turn.completed", "turn.failed"].includes(type);
  }
  normalize(record: NativeRecord, context: HarnessCorrelation): HarnessEvent[] {
    const type = recordType(record.value);
    const data = { nativeType: type, summary: textOf(record.value) };
    if (type === "thread.started")
      return [this.event(record, context, "ready", data, true)];
    if (type === "turn.started")
      return [this.event(record, context, "workStarted", data)];
    if (type === "item.started")
      return [this.event(record, context, "toolStarted", data)];
    if (type === "item.updated")
      return [this.event(record, context, "toolProgress", data)];
    if (type === "item.completed")
      return [this.event(record, context, "toolCompleted", data)];
    if (type === "turn.completed")
      return [
        {
          ...this.event(record, context, "settled", data, true),
          usage: usageOf(record.value, "exact"),
        },
      ];
    if (["turn.failed", "error"].includes(type))
      return [this.event(record, context, "failed", data, true)];
    return [];
  }
}

export function encodeLfCommand(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export class HarnessProtocolCompatibilityError extends Error {
  constructor(
    readonly harness: string,
    readonly codecVersion: string,
    readonly nativeType: string,
    readonly cursor: string,
  ) {
    super(
      `Codec ${codecVersion} cannot normalize required ${harness} event ${nativeType} at cursor ${cursor}`,
    );
    this.name = "HarnessProtocolCompatibilityError";
  }
}

export function normalizeNativeRecord(
  codec: HarnessCodec,
  record: NativeRecord,
  context: HarnessCorrelation,
): HarnessEvent[] {
  const events = codec.normalize(record, context);
  const type = recordType(record.value);
  if (events.length === 0 && codec.isRequiredNativeType(type))
    throw new HarnessProtocolCompatibilityError(
      codec.harness,
      codec.version,
      type,
      record.cursor,
    );
  return events;
}
