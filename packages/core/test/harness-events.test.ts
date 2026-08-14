import {
  appendFile,
  mkdtemp,
  readFile,
  stat,
  symlink,
  truncate,
  unlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeStreamJsonCodec,
  CodexJsonlCodec,
  EffectHarnessBridge,
  HarnessPaneRenderer,
  HarnessNormalizedStreamConsumer,
  HarnessProtocolStore,
  PiRpcCodec,
  frameLf,
  harnessBridgeArguments,
  normalizedEvent,
  normalizeNativeRecord,
  reduceHarnessEvents,
  resolveHarnessPresentation,
  writeHarnessBridgeDescriptor,
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
  it("durably consumes normalized events across restarts and suppresses duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-consumer-"));
    const store = new HarnessProtocolStore(root, "run", "consumer");
    await store.initialize({
      ...context,
      invocationId: "consumer",
      schemaVersion: 1,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    const ready = event("ready", 1);
    const settled = event("settled", 2);
    await store.appendNormalized(ready);
    await store.appendNormalized(settled);

    const first = await new HarnessNormalizedStreamConsumer(store).poll();
    expect(first.events).toEqual([ready, settled]);
    expect(first.state.status).toBe("settled");
    expect((await stat(store.serviceCursorPath)).mode & 0o777).toBe(0o600);

    const restarted = new HarnessNormalizedStreamConsumer(store);
    const afterRestart = await restarted.poll();
    expect(afterRestart.events).toEqual([]);
    expect(afterRestart.state.status).toBe("settled");

    await store.appendNormalized(ready);
    const duplicate = await restarted.poll();
    expect(duplicate.events).toEqual([]);
    expect(duplicate.state.seenEventIds.size).toBe(2);
  });

  it("waits for complete normalized records and rejects unsafe stream changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-consumer-safety-"));
    const store = new HarnessProtocolStore(root, "run", "consumer-safety");
    await store.initialize({
      ...context,
      invocationId: "consumer-safety",
      schemaVersion: 1,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    const ready = event("ready", 1);
    const line = JSON.stringify(ready);
    await appendFile(store.normalizedPath, line.slice(0, -1));
    const consumer = new HarnessNormalizedStreamConsumer(store);
    expect((await consumer.poll()).events).toEqual([]);
    await appendFile(store.normalizedPath, `${line.slice(-1)}\n`);
    expect((await consumer.poll()).events).toEqual([ready]);

    await truncate(store.normalizedPath, 0);
    await expect(consumer.poll()).rejects.toThrow("truncated behind");

    const missing = new HarnessProtocolStore(root, "run", "missing");
    await expect(
      new HarnessNormalizedStreamConsumer(missing).poll(),
    ).rejects.toThrow(
      "Required normalized capture is missing for invocation missing",
    );

    const linked = new HarnessProtocolStore(root, "run", "linked");
    await linked.initialize({
      ...context,
      invocationId: "linked",
      schemaVersion: 1,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    await unlink(linked.normalizedPath);
    await symlink(store.controlPath, linked.normalizedPath);
    await expect(
      new HarnessNormalizedStreamConsumer(linked).poll(),
    ).rejects.toThrow("refuses symbolic links");
  });

  it("fails closed when a normalized record exceeds the polling bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-consumer-bound-"));
    const store = new HarnessProtocolStore(root, "run", "consumer-bound");
    await store.initialize({
      ...context,
      invocationId: "consumer-bound",
      schemaVersion: 1,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    await appendFile(store.normalizedPath, "x".repeat(32));
    await expect(
      new HarnessNormalizedStreamConsumer(store, 16).poll(),
    ).rejects.toThrow("exceeds the 16-byte polling bound");
  });

  it("reports actionable compatibility evidence for malformed normalized capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-consumer-malformed-"));
    const store = new HarnessProtocolStore(root, "run", "malformed");
    await store.initialize({
      ...context,
      invocationId: "malformed",
      schemaVersion: 1,
      codecVersion: "test-v1",
      presentationLevel: "normal",
      createdAt: new Date().toISOString(),
      captureHealth: "healthy",
    });
    await appendFile(store.normalizedPath, '{"type":"future-terminal"}\n');
    await expect(
      new HarnessNormalizedStreamConsumer(store).poll(),
    ).rejects.toThrow(
      "Normalized capture is incompatible at byte 0 for invocation malformed",
    );
  });
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

  it("normalizes installed Pi 0.83 RPC shapes with correlation, retries, compaction, UI, and exact usage", async () => {
    const fixture = await readFile(
      new URL("./fixtures/pi-rpc-0.83.0.jsonl", import.meta.url),
      "utf8",
    );
    const codec = new PiRpcCodec();
    const events = fixture
      .trim()
      .split("\n")
      .flatMap((line, index) =>
        normalizeNativeRecord(
          codec,
          codec.parse(line, String(index + 1)),
          context,
        ),
      );
    expect(events[0]).toMatchObject({
      type: "ready",
      nativeSessionId: "session-123",
      data: { requestId: "state-1", command: "get_state" },
    });
    expect(
      events.find(({ type }) => type === "promptAccepted")?.data,
    ).toMatchObject({ requestId: "prompt-1" });
    expect(events.filter(({ type }) => type === "messageSummary")).toHaveLength(
      1,
    );
    expect(events.find(({ type }) => type === "blocked")?.data).toMatchObject({
      requestId: "question-1",
      method: "confirm",
    });
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "workStarted",
        "toolStarted",
        "toolProgress",
        "toolCompleted",
        "usage",
        "compactionStarted",
        "compactionCompleted",
        "retryStarted",
        "retryCompleted",
        "completed",
        "settled",
        "diagnostic",
      ]),
    );
    expect(events.find(({ type }) => type === "usage")?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      costUsd: 0.002,
      quality: "exact",
    });
    expect(reduceHarnessEvents(events)).toMatchObject({
      status: "settled",
      nativeSessionId: "session-123",
    });
    const renderer = new HarnessPaneRenderer({ level: "normal" });
    const output = events.flatMap((event) => renderer.render(event) ?? []);
    expect(output.join("\n")).not.toContain("Repeated accumulated partial");
    expect(output.join("\n")).not.toContain("signature-value");
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

  it("renders a common semantic matrix across harnesses, tools, failures, retries, and usage quality", () => {
    for (const [index, harness] of ["pi", "claude", "codex"].entries()) {
      const renderer = new HarnessPaneRenderer({ level: "normal" });
      const started = normalizedEvent({
        ...context,
        invocationId: `${harness}-invocation`,
        harness,
        sourceCursor: "start",
        timestamp: "2026-08-14T00:00:00.000Z",
        type: "processStarted",
        required: false,
        sequence: index,
        data: { model: "test-model" },
      });
      expect(renderer.render(started)).toContain(
        `building · ${harness} · test-model · run`,
      );
    }

    const normal = new HarnessPaneRenderer({
      level: "normal",
      maxToolLength: 48,
    });
    const customTool = {
      ...event("toolStarted", 10),
      data: { tool: "custom_widget", summary: "z".repeat(200) },
    };
    expect(normal.render(customTool)).toBe(
      `  • Used ${"z".repeat(30)}… [inspect retained]`,
    );
    expect(
      normal.render({
        ...event("retryStarted", 11),
        data: { message: "api_key=super-secret-value" },
      }),
    ).toBe("  ↻ Retrying");
    expect(
      normal.render({
        ...event("failed", 12),
        data: { summary: "token=super-secret-value failure" },
      }),
    ).toBe("✗ Failed: [REDACTED] failure");

    for (const [quality, tokens] of [
      ["exact", 20],
      ["estimated", 21],
      ["unknown", 22],
    ] as const) {
      const renderer = new HarnessPaneRenderer();
      renderer.render({
        ...event("usage", tokens),
        usage: {
          totalTokens: quality === "unknown" ? undefined : 1_234,
          quality,
        },
      });
      const completed = renderer.render({
        ...event("settled", tokens + 10),
        data: { durationMs: 2_400 },
      });
      expect(completed).toContain(`usage ${quality}`);
      if (quality === "unknown") expect(completed).not.toContain("tokens");
      else expect(completed).toContain("1,234 tokens");
    }
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
    expect(result.events.map(({ type }) => type)).toEqual([
      "ready",
      "completed",
      "usage",
      "settled",
    ]);
    expect(rendered).toContain("  Ready");
    expect(
      (await store.events()).find(({ type }) => type === "usage")?.usage
        ?.totalTokens,
    ).toBe(3);
  });

  it("runs the pane bridge executable and relays private Pi control without raw pane JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-bridge-cli-"));
    const store = new HarnessProtocolStore(root, "run", "pi-cli");
    const nativeScript = [
      "let input='';",
      "process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);if(!line)continue;const command=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',command:'prompt',success:true,id:command.id})+'\\n');process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');process.stdout.write(JSON.stringify({type:'agent_end',willRetry:true})+'\\n');process.stdout.write(JSON.stringify({type:'auto_retry_start'})+'\\n');process.stdout.write(JSON.stringify({type:'auto_retry_end',success:true})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled',usage:{input_tokens:2,output_tokens:1},thinking_signature:'private'})+'\\n');process.exit(0);}});",
    ].join("");
    const descriptorPath = await writeHarnessBridgeDescriptor(store, {
      schemaVersion: 1,
      stateDirectory: root,
      command: process.execPath,
      args: ["-e", nativeScript],
      cwd: root,
      context: { ...context, invocationId: "pi-cli" },
      codecVersion: "pi-rpc-v1",
      presentationLevel: "normal",
    });
    const child = spawn(
      process.execPath,
      harnessBridgeArguments(descriptorPath),
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const prompt = "private prompt text";
    await store.appendControl({
      action: "send",
      value: { type: "prompt", id: "request-1", message: prompt },
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("bridge CLI timed out")),
        5_000,
      );
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(exit, stderr).toBe(0);
    expect(stdout).not.toContain('{"type"');
    expect(stdout).not.toContain(prompt);
    const events = await store.events();
    expect(events.map(({ type }) => type)).toEqual([
      "promptAccepted",
      "workStarted",
      "completed",
      "retryStarted",
      "retryCompleted",
      "usage",
      "settled",
    ]);
    expect(reduceHarnessEvents(events).status).toBe("settled");
    expect(await readFile(store.nativePath, "utf8")).not.toContain("private");
    expect(await readFile(store.controlPath, "utf8")).toContain(prompt);
    expect(child.spawnargs.join(" ")).not.toContain(prompt);
  });

  it("handles stdin backpressure, stderr capture, signals, and renderer degradation", async () => {
    const root = await mkdtemp(join(tmpdir(), "swf-bridge-lifecycle-"));
    const contextFor = (invocationId: string, harness = "pi") => ({
      ...context,
      invocationId,
      harness,
    });

    const backpressureStore = new HarnessProtocolStore(
      root,
      "run",
      "backpressure",
    );
    const backpressure = await new EffectHarnessBridge().start({
      command: process.execPath,
      args: [
        "-e",
        "let s='';process.stdin.on('data',c=>{s+=c;if(s.includes('\\n')){process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');process.exit(0)}})",
      ],
      cwd: root,
      context: contextFor("backpressure"),
      codec: new PiRpcCodec(),
      store: backpressureStore,
      metadata: {
        ...contextFor("backpressure"),
        codecVersion: "pi-rpc-v1",
        presentationLevel: "quiet",
      },
    });
    await backpressure.send({ type: "prompt", message: "x".repeat(2_000_000) });
    await expect(backpressure.settled).resolves.toMatchObject({ code: 0 });

    const signalStore = new HarnessProtocolStore(root, "run", "signal");
    const signalled = await new EffectHarnessBridge().start({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('diagnostic stderr');process.on('SIGTERM',()=>{process.stdout.write(JSON.stringify({type:'cancelled'})+'\\n');process.exit(0)});setInterval(()=>{},1000)",
      ],
      cwd: root,
      context: contextFor("signal"),
      codec: new PiRpcCodec(),
      store: signalStore,
      metadata: {
        ...contextFor("signal"),
        codecVersion: "pi-rpc-v1",
        presentationLevel: "quiet",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await signalled.cancel();
    expect((await signalStore.events()).at(-1)?.type).toBe("cancelled");
    expect(await readFile(signalStore.nativePath, "utf8")).toContain(
      "diagnostic stderr",
    );

    class BrokenRenderer extends HarnessPaneRenderer {
      override render(): string | undefined {
        throw new Error("renderer exploded");
      }
    }
    const degradedStore = new HarnessProtocolStore(root, "run", "degraded");
    const degraded = await new EffectHarnessBridge().start({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({type:'thread.started'})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n')",
      ],
      cwd: root,
      context: contextFor("degraded", "codex"),
      codec: new CodexJsonlCodec(),
      store: degradedStore,
      metadata: {
        ...contextFor("degraded", "codex"),
        codecVersion: "codex-jsonl-v1",
        presentationLevel: "normal",
      },
      renderer: new BrokenRenderer(),
    });
    await degraded.settled;
    expect((await degradedStore.events()).map(({ type }) => type)).toEqual([
      "ready",
      "diagnostic",
      "completed",
      "diagnostic",
      "settled",
      "diagnostic",
    ]);

    const partialStore = new HarnessProtocolStore(
      root,
      "run",
      "partial-terminal",
    );
    const partial = await new EffectHarnessBridge().start({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(\'{\\"type\\":\\"agent_settled\\"\')'],
      cwd: root,
      context: contextFor("partial-terminal"),
      codec: new PiRpcCodec(),
      store: partialStore,
      metadata: {
        ...contextFor("partial-terminal"),
        codecVersion: "pi-rpc-v1",
        presentationLevel: "quiet",
      },
    });
    await partial.settled;
    expect(await partialStore.events()).toEqual([
      expect.objectContaining({
        type: "failed",
        data: expect.objectContaining({ code: "missing-terminal-event" }),
      }),
    ]);
    expect(await readFile(partialStore.nativePath, "utf8")).toContain(
      "trailingPartial",
    );
  });
});
