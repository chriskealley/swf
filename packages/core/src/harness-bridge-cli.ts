#!/usr/bin/env node
import {
  CodexJsonlCodec,
  ClaudeStreamJsonCodec,
  PiRpcCodec,
} from "./harness-codecs.js";
import {
  EffectHarnessBridge,
  consumeHarnessBridgeDescriptor,
} from "./harness-bridge.js";
import { HarnessPaneRenderer } from "./harness-presentation.js";
import { HarnessProtocolStore } from "./harness-protocol.js";

function codecFor(harness: string) {
  if (harness === "pi") return new PiRpcCodec();
  if (harness === "claude") return new ClaudeStreamJsonCodec();
  if (harness === "codex") return new CodexJsonlCodec();
  throw new Error(`No bridge codec is registered for ${harness}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const descriptorPath = process.argv[2];
  if (!descriptorPath)
    throw new Error("Harness bridge requires a descriptor path");
  const descriptor = await consumeHarnessBridgeDescriptor(descriptorPath);
  const store = new HarnessProtocolStore(
    descriptor.stateDirectory,
    descriptor.context.runId,
    descriptor.context.invocationId,
  );
  const codec = codecFor(descriptor.context.harness);
  const handle = await new EffectHarnessBridge().start({
    command: descriptor.command,
    args: descriptor.args,
    cwd: descriptor.cwd,
    environment: descriptor.environment,
    context: descriptor.context,
    codec,
    store,
    metadata: {
      ...descriptor.context,
      codecVersion: descriptor.codecVersion,
      cwd: descriptor.cwd,
      presentationLevel: descriptor.presentationLevel,
      bridgePid: process.pid,
    },
    renderer: new HarnessPaneRenderer({ level: descriptor.presentationLevel }),
    onPresentation: (line) => process.stdout.write(`${line}\n`),
  });
  if (descriptor.initialInput) {
    if (descriptor.initialInput.format === "jsonl")
      await handle.send(descriptor.initialInput.value);
    else await handle.sendRaw(String(descriptor.initialInput.value));
    if (descriptor.closeInputAfterInitial) await handle.closeInput();
  }
  let controlOffset = descriptor.controlOffset ?? 0;
  let closed = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (closed) return;
    closed = true;
    await handle.cancel(signal);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  const control = (async () => {
    while (!closed) {
      const next = await store.readControl(controlOffset);
      controlOffset = next.offset;
      for (const command of next.commands) {
        if (!command || typeof command !== "object") continue;
        const entry = command as { action?: string; value?: unknown };
        if (entry.action === "send") await handle.send(entry.value);
        if (entry.action === "cancel") {
          if (entry.value !== undefined) await handle.send(entry.value);
          await delay(100);
          await stop("SIGTERM");
        }
      }
      await delay(50);
    }
  })();
  const result = await handle.settled;
  closed = true;
  await control;
  if (result.code && result.code !== 0) process.exitCode = result.code;
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
