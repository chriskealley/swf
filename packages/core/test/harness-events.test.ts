import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeStreamJsonCodec,
  CodexJsonlCodec,
  EffectHarnessBridge,
  HarnessPaneRenderer,
  HarnessProtocolStore,
  PiRpcCodec,
  frameLf,
  normalizedEvent,
  normalizeNativeRecord,
  reduceHarnessEvents,
  resolveHarnessPresentation,
} from "../src/index.js";

const context = {
  projectId: "project",
  runId: "run",
  phaseId: "building",
  workUnitId: "agent",
  invocationId: "invocation",
  harness: "pi",
};
function event(
  type: Parameters<typeof normalizedEvent>[0]["type"],
  sequence: number,
) {
  return normalizedEvent({
    ...context,
    sourceCursor: String(sequence),
    timestamp: "2026-08-14T00:00:00.000Z",
    type,
    required: false,
    sequence,
    data: {},
  });
}

describe("normalized harness events", () => {
  it("suppresses replay duplicates and rejects out-of-order events", () => {
    const started = event("workStarted", 1);
    const settled = event("settled", 2);
    const state = reduceHarnessEvents([started, started, settled]);
    expect(state.status).toBe("settled");
    expect(state.seenEventIds.size).toBe(2);
    expect(() => reduceHarnessEvents([settled, started])).toThrow(
      /Out-of-order/,
    );
  });

  it("frames only LF and preserves Unicode separators and trailing partials", () => {
    const result = frameLf(Buffer.from('{"text":"a b c"}\n{"partial":'));
    expect(result.records).toEqual(['{"text":"a b c"}']);
    const end = frameLf(Buffer.alloc(0), result.remainder, true);
    expect(end.records).toEqual([]);
    expect(end.trailingPartial).toBe('{"partial":');
  });

  it("normalizes terminal semantics without treating Pi agent_end as settled", () => {
    const pi = new PiRpcCodec();
    const completed = pi.normalize(
      pi.parse('{"type":"agent_end"}', "1"),
      context,
    );
    const settled = pi.normalize(
      pi.parse('{"type":"agent_settled"}', "2"),
      context,
    );
    expect(completed[0]?.type).toBe("completed");
    expect(settled[0]?.type).toBe("settled");
    expect(new ClaudeStreamJsonCodec().version).toContain("claude");
    expect(new CodexJsonlCodec().version).toContain("codex");
  });

  it("ignores unknown optional records and fails closed for incompatible required records", () => {
    const pi = new PiRpcCodec();
    expect(
      normalizeNativeRecord(
        pi,
        pi.parse('{"type":"future_optional"}', "3"),
        context,
      ),
    ).toEqual([]);
    const incompatible = Object.create(pi) as PiRpcCodec;
    incompatible.normalize = () => [];
    expect(() =>
      normalizeNativeRecord(
        incompatible,
        pi.parse('{"type":"agent_settled"}', "4"),
        context,
      ),
    ).toThrow(/cannot normalize required/);
  });

  it("renders semantic levels, bounds output, and redacts secrets", () => {
    expect(resolveHarnessPresentation({}).value.level).toBe("normal");
    const verbose = new HarnessPaneRenderer({
      level: "verbose",
      maxTextLength: 64,
    });
    const line = verbose.render({
      ...event("diagnostic", 1),
      data: { message: `api_key=super-secret-value ${"x".repeat(200)}` },
    });
    expect(line).toContain("[REDACTED]");
    expect(line!.length).toBeLessThan(100);
    expect(
      new HarnessPaneRenderer({ level: "quiet" }).render(
        event("toolStarted", 2),
      ),
    ).toBeUndefined();
  });

  it("creates private streams, rebuilds cursors, and returns bounded inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-harness-"));
    const store = new HarnessProtocolStore(root, "run", "invocation");
    await store.initialize({
      schemaVersion: 1,
      ...context,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    await store.appendNative({ token: "ghp_abcdefghijklmnopqrstuvwxyz" });
    await store.appendNormalized(event("ready", 1));
    const cursor = await store.rebuildCursor();
    expect(cursor.nativeOffset).toBeGreaterThan(0);
    expect(cursor.lastEventId).toBe(event("ready", 1).eventId);
    expect((await stat(store.nativePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.nativePath, "utf8")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz",
    );
    expect((await store.inspectNative({ limit: 1 })).records).toHaveLength(1);
  });

  it("captures a native subprocess independently from rendered output", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-bridge-"));
    const store = new HarnessProtocolStore(root, "run", "bridge");
    const rendered: string[] = [];
    const handle = await new EffectHarnessBridge().start({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t1'})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{total_tokens:3}})+'\\n')",
      ],
      cwd: root,
      context: { ...context, invocationId: "bridge", harness: "codex" },
      codec: new CodexJsonlCodec(),
      store,
      metadata: {
        ...context,
        invocationId: "bridge",
        harness: "codex",
        codecVersion: "codex-jsonl-v1",
        presentationLevel: "normal",
      },
      renderer: new HarnessPaneRenderer(),
      onPresentation: (line) => rendered.push(line),
    });
    const result = await handle.settled;
    expect(result.code).toBe(0);
    expect(result.events.map(({ type }) => type)).toEqual(["ready", "settled"]);
    expect(rendered).toContain("  Ready");
    expect((await store.events()).at(-1)?.usage?.totalTokens).toBe(3);
  });
});
