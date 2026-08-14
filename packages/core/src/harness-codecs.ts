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
  const cost = nested(usage.cost);
  const costUsd = number(
    usage.cost_usd ?? usage.costUsd ?? cost?.total ?? value.total_cost_usd,
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
  const direct = candidates.find(
    (entry): entry is string => typeof entry === "string",
  );
  if (direct) return direct;
  const content = nested(value.message)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map(nested)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter(
        (entry) => entry.type === "text" && typeof entry.text === "string",
      )
      .map((entry) => entry.text as string)
      .join("\n");
    if (text) return text;
  }
  const assistantEvent = nested(value.assistantMessageEvent);
  return typeof assistantEvent?.delta === "string"
    ? assistantEvent.delta
    : undefined;
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
      nested(record.value.data)?.session_id,
      nested(record.value.data)?.sessionId,
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
    const requestId = [
      record.value.id,
      record.value.request_id,
      record.value.requestId,
    ].find((value): value is string => typeof value === "string");
    const data = {
      nativeType: type,
      summary: textOf(record.value),
      ...(requestId ? { requestId } : {}),
    };
    const events: HarnessEvent[] = [];
    const command =
      typeof record.value.command === "string"
        ? record.value.command
        : undefined;
    const success = record.value.success !== false;
    if (["process_started", "session_start"].includes(type))
      events.push(this.event(record, context, "processStarted", data));
    else if (["ready", "session_ready"].includes(type))
      events.push(this.event(record, context, "ready", data));
    if (type === "response" && !success)
      events.push(
        this.event(
          record,
          context,
          "failed",
          { ...data, command, message: record.value.error },
          true,
        ),
      );
    else if (type === "response" && command === "get_state")
      events.push(
        this.event(record, context, "ready", { ...data, command }, true),
      );
    else if (
      type === "response" &&
      ["prompt", "steer", "follow_up"].includes(command ?? "")
    )
      events.push(
        this.event(record, context, "promptAccepted", { ...data, command }),
      );
    else if (type === "response" && command === "abort")
      events.push(
        this.event(record, context, "cancelled", { ...data, command }),
      );
    else if (type === "prompt_accepted")
      events.push(this.event(record, context, "promptAccepted", data));
    else if (
      [
        "agent_start",
        "turn_start",
        "follow_up",
        "continuation_started",
      ].includes(type)
    )
      events.push(this.event(record, context, "workStarted", data, true));
    else if (["message_end", "assistant_message"].includes(type))
      events.push(this.event(record, context, "messageSummary", data));
    if (["tool_execution_start", "tool_start"].includes(type))
      events.push(
        this.event(record, context, "toolStarted", {
          ...data,
          tool: record.value.toolName ?? record.value.tool_name,
        }),
      );
    else if (["tool_execution_update", "tool_update"].includes(type))
      events.push(this.event(record, context, "toolProgress", data));
    else if (["tool_execution_end", "tool_end"].includes(type))
      events.push(this.event(record, context, "toolCompleted", data));
    else if (
      type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(
        String(record.value.method),
      )
    )
      events.push(
        this.event(record, context, "blocked", {
          ...data,
          prompt:
            record.value.title ??
            record.value.message ??
            record.value.placeholder,
          method: record.value.method,
        }),
      );
    else if (type === "extension_ui_request")
      events.push(
        this.event(record, context, "diagnostic", {
          ...data,
          method: record.value.method,
        }),
      );
    else if (type === "queue_update") {
      const steering = Array.isArray(record.value.steering)
        ? record.value.steering
        : [];
      const followUp = Array.isArray(record.value.followUp)
        ? record.value.followUp
        : [];
      if (steering.length || followUp.length)
        events.push(
          this.event(record, context, "workStarted", {
            ...data,
            queued: steering.length + followUp.length,
          }),
        );
    } else if (
      [
        "auto_retry_start",
        "summarization_retry_scheduled",
        "summarization_retry_attempt_start",
      ].includes(type)
    )
      events.push(this.event(record, context, "retryStarted", data));
    else if (["auto_retry_end", "summarization_retry_finished"].includes(type))
      events.push(this.event(record, context, "retryCompleted", data));
    else if (type.includes("compaction") && type.includes("start"))
      events.push(this.event(record, context, "compactionStarted", data));
    else if (type.includes("compaction"))
      events.push(this.event(record, context, "compactionCompleted", data));
    else if (["agent_end", "turn_end"].includes(type))
      events.push(this.event(record, context, "completed", data));
    else if (type === "agent_settled") {
      const usage = usageOf(record.value, "exact");
      if (usage)
        events.push({ ...this.event(record, context, "usage", data), usage });
      events.push(this.event(record, context, "settled", data, true));
      return events;
    } else if (["abort", "cancelled"].includes(type))
      events.push(this.event(record, context, "cancelled", data));
    else if (["error", "failed"].includes(type))
      events.push(this.event(record, context, "failed", data, true));
    const usage = usageOf(record.value, "exact");
    if (usage)
      events.push({ ...this.event(record, context, "usage", data), usage });
    return events;
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
    if (type === "assistant") {
      const events = [this.event(record, context, "workStarted", data)];
      const content = nested(record.value.message)?.content;
      if (data.summary)
        events.push(this.event(record, context, "messageSummary", data));
      if (Array.isArray(content))
        for (const block of content.map(nested)) {
          if (block?.type !== "tool_use") continue;
          events.push(
            this.event(record, context, "toolStarted", {
              ...data,
              tool: block.name,
              toolCallId: block.id,
            }),
          );
        }
      const usage = usageOf(record.value, "estimated");
      if (usage)
        events.push({ ...this.event(record, context, "usage", data), usage });
      return events;
    }
    if (type === "user") {
      const content = nested(record.value.message)?.content;
      if (!Array.isArray(content)) return [];
      return content
        .map(nested)
        .filter(
          (block): block is Record<string, unknown> =>
            block?.type === "tool_result",
        )
        .map((block) =>
          this.event(record, context, "toolCompleted", {
            nativeType: type,
            toolCallId: block.tool_use_id,
            failed: block.is_error === true,
          }),
        );
    }
    if (["tool_use", "tool_start"].includes(type))
      return [this.event(record, context, "toolStarted", data)];
    if (["tool_result", "tool_end"].includes(type))
      return [this.event(record, context, "toolCompleted", data)];
    if (type === "result") {
      const usage = usageOf(record.value, "estimated");
      if (record.value.is_error === true)
        return [
          { ...this.event(record, context, "failed", data, true), usage },
        ];
      const events: HarnessEvent[] = [
        this.event(record, context, "completed", data, true),
      ];
      if (usage)
        events.push({ ...this.event(record, context, "usage", data), usage });
      events.push(this.event(record, context, "settled", data, true));
      return events;
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
    const item = nested(record.value.item);
    const itemType = typeof item?.type === "string" ? item.type : undefined;
    const data = {
      nativeType: type,
      itemType,
      itemId: item?.id,
      summary:
        textOf(record.value) ??
        (typeof item?.text === "string" ? item.text : undefined),
    };
    if (type === "thread.started")
      return [this.event(record, context, "ready", data, true)];
    if (type === "turn.started")
      return [this.event(record, context, "workStarted", data)];
    if (type === "item.started") {
      if (["agent_message", "reasoning"].includes(itemType ?? "")) return [];
      return [
        this.event(record, context, "toolStarted", {
          ...data,
          tool: itemType,
          command: item?.command,
        }),
      ];
    }
    if (
      type === "item.updated" &&
      !["agent_message", "reasoning"].includes(itemType ?? "")
    )
      return [this.event(record, context, "toolProgress", data)];
    if (type === "item.completed") {
      if (itemType === "agent_message")
        return [this.event(record, context, "messageSummary", data)];
      if (itemType === "reasoning") return [];
      return [
        this.event(record, context, "toolCompleted", {
          ...data,
          tool: itemType,
          command: item?.command,
          output: item?.aggregated_output,
          failed: item?.status === "failed",
        }),
      ];
    }
    if (type === "turn.completed") {
      const usage = usageOf(record.value, "exact");
      const events: HarnessEvent[] = [
        this.event(record, context, "completed", data, true),
      ];
      if (usage)
        events.push({ ...this.event(record, context, "usage", data), usage });
      events.push(this.event(record, context, "settled", data, true));
      return events;
    }
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
