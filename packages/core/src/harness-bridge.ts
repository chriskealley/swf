import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import type {
  HarnessCodec,
  HarnessCorrelation,
  HarnessEvent,
} from "./harness-events.js";
import { normalizeNativeRecord } from "./harness-codecs.js";
import { HarnessPaneRenderer } from "./harness-presentation.js";
import {
  HarnessProtocolStore,
  type HarnessInvocationMetadata,
} from "./harness-protocol.js";

export interface HarnessBridgeRequest {
  command: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string>;
  context: HarnessCorrelation;
  codec: HarnessCodec;
  store: HarnessProtocolStore;
  metadata: Omit<
    HarnessInvocationMetadata,
    "schemaVersion" | "createdAt" | "captureHealth"
  >;
  renderer?: HarnessPaneRenderer;
  onPresentation?: (line: string) => void;
  onEvent?: (event: HarnessEvent) => Promise<void> | void;
}
export interface HarnessBridgeHandle {
  readonly pid: number;
  readonly settled: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    events: HarnessEvent[];
  }>;
  send(value: unknown): Promise<void>;
  cancel(signal?: NodeJS.Signals): Promise<void>;
}

export interface HarnessProcessControlService {
  spawn(
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ): ChildProcessWithoutNullStreams;
}
export const HarnessProcessControl =
  Context.Service<HarnessProcessControlService>("@swf/HarnessProcessControl");
export const HarnessProcessControlLive = Layer.succeed(HarnessProcessControl)({
  spawn: (command, args, options) =>
    spawn(command, args, options) as ChildProcessWithoutNullStreams,
});

function waitForDrain(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.once("drain", resolve);
    child.stdin.once("error", reject);
  });
}

export class EffectHarnessBridge {
  start(request: HarnessBridgeRequest): Promise<HarnessBridgeHandle> {
    const program = Effect.gen(function* () {
      const processControl = yield* HarnessProcessControl;
      return yield* Effect.tryPromise({
        try: async () => {
          await request.store.initialize({
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            captureHealth: "healthy",
            ...request.metadata,
          });
          const child = processControl.spawn(request.command, request.args, {
            cwd: request.cwd,
            env: { ...process.env, ...request.environment },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          const events: HarnessEvent[] = [];
          let cursor = 0;
          let finalized = false;
          let processing = Promise.resolve();
          const consume = async (chunk: Buffer, end = false) => {
            const framed = request.codec.frame(chunk, end);
            for (const raw of framed.records) {
              cursor += 1;
              try {
                const record = request.codec.parse(raw, String(cursor));
                await request.store.appendNative({
                  cursor: record.cursor,
                  identity: record.identity,
                  value: record.value,
                });
                for (const event of normalizeNativeRecord(
                  request.codec,
                  record,
                  request.context,
                )) {
                  await request.store.appendNormalized(event);
                  events.push(event);
                  await request.onEvent?.(event);
                  if (request.renderer) {
                    try {
                      const line = request.renderer.render(event, record.value);
                      if (line) request.onPresentation?.(line);
                    } catch (error) {
                      const diagnostic = {
                        ...event,
                        eventId: `${event.eventId}:presentation`,
                        type: "diagnostic" as const,
                        required: false,
                        data: {
                          code: "presentation-degraded",
                          message:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        },
                      };
                      await request.store.appendNormalized(diagnostic);
                      events.push(diagnostic);
                    }
                  }
                }
              } catch (error) {
                await request.store.appendNative({
                  cursor: String(cursor),
                  malformed: true,
                  diagnostic: String(error),
                  bounded: raw.slice(0, 4096),
                });
              }
            }
            if (framed.trailingPartial)
              await request.store.appendNative({
                cursor: `${cursor}:partial`,
                malformed: true,
                trailingPartial: framed.trailingPartial,
              });
            const state = await request.store.rebuildCursor();
            await request.store.writeCursor(state);
          };
          child.stdout.on("data", (chunk: Buffer) => {
            processing = processing.then(() => consume(chunk));
          });
          child.stderr.on("data", (chunk: Buffer) => {
            void request.store.appendNative({
              stream: "stderr",
              value: chunk.toString("utf8").slice(0, 4096),
            });
          });
          const settled = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
            events: HarnessEvent[];
          }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => {
              void (async () => {
                await processing;
                if (!finalized) {
                  finalized = true;
                  await consume(Buffer.alloc(0), true);
                }
                resolve({ code, signal, events });
              })().catch(reject);
            });
          });
          return {
            pid: child.pid!,
            settled,
            async send(value: unknown): Promise<void> {
              const line = `${JSON.stringify(value)}\n`;
              if (!child.stdin.write(line)) await waitForDrain(child);
            },
            async cancel(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
              if (finalized) return;
              child.kill(signal);
              await settled;
            },
          };
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
    });
    return Effect.runPromise(
      Effect.provide(program, HarnessProcessControlLive),
    );
  }
}

export class HarnessLifecycleSupervisor {
  private readonly handles = new Map<string, HarnessBridgeHandle>();
  register(invocationId: string, handle: HarnessBridgeHandle): void {
    this.handles.set(invocationId, handle);
    void handle.settled.finally(() => this.handles.delete(invocationId));
  }
  get(invocationId: string): HarnessBridgeHandle | undefined {
    return this.handles.get(invocationId);
  }
  async interruptAndJoin(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all(
      [...this.handles.values()].map((handle) => handle.cancel(signal)),
    );
  }
  async join(): Promise<void> {
    await Promise.all(
      [...this.handles.values()].map((handle) =>
        handle.settled.then(() => undefined),
      ),
    );
  }
}
