import { Context, Effect, FiberMap, Layer, ManagedRuntime } from "effect";

export interface SupervisedHarnessInvocation {
  invocationId: string;
  run(signal: AbortSignal): Promise<void>;
  interrupt(): Promise<void>;
  finalize?(): Promise<void>;
}

export interface SupervisedHarnessPoll {
  invocationId: string;
  poll(): Promise<"continue" | "done">;
  intervalMs: number;
  interrupt(): Promise<void>;
  finalize?(): Promise<void>;
}

interface HarnessSupervisorState {
  readonly fibers: FiberMap.FiberMap<string, void, Error>;
}

const HarnessSupervisorState = Context.Service<HarnessSupervisorState>(
  "@swf/HarnessSupervisorState",
);

const HarnessSupervisorLayer = Layer.effect(HarnessSupervisorState)(
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string, void, Error>();
    return { fibers };
  }),
);

interface SupervisionEntry {
  stop(): void;
  stopped: Promise<void>;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Service-owned Effect scope for invocation lifecycle fibers. Durable run and
 * protocol files remain authoritative; this class only owns live supervision.
 */
export class HarnessLifecycleSupervisor {
  private readonly runtime = ManagedRuntime.make(HarnessSupervisorLayer);
  private readonly entries = new Map<string, SupervisionEntry>();
  private disposed = false;

  async supervise(task: SupervisedHarnessInvocation): Promise<boolean> {
    const work = Effect.tryPromise({
      try: (signal) => task.run(signal),
      catch: asError,
    });
    return this.install(task, work);
  }

  async supervisePolling(task: SupervisedHarnessPoll): Promise<boolean> {
    const loop = (): Effect.Effect<void, Error> =>
      Effect.tryPromise({ try: () => task.poll(), catch: asError }).pipe(
        Effect.flatMap((result) =>
          result === "done"
            ? Effect.void
            : Effect.sleep(task.intervalMs).pipe(
                Effect.andThen(Effect.suspend(loop)),
              ),
        ),
      );
    return this.install(task, loop());
  }

  private async install(
    task: Pick<
      SupervisedHarnessInvocation,
      "invocationId" | "interrupt" | "finalize"
    >,
    taskEffect: Effect.Effect<void, Error>,
  ): Promise<boolean> {
    if (this.disposed)
      throw new Error("Harness lifecycle supervisor is closed");
    if (this.entries.has(task.invocationId)) return false;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const entry = { stop, stopped };
    this.entries.set(task.invocationId, entry);
    let finalized = false;
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      this.entries.delete(task.invocationId);
      await task.finalize?.();
    };
    const work = Effect.raceFirst(
      taskEffect,
      Effect.promise(() => stopped),
    ).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(() => task.interrupt()).pipe(
          Effect.catchCause(() => Effect.void),
        ),
      ),
      Effect.ensuring(
        Effect.promise(() => finalize()).pipe(
          Effect.catchCause(() => Effect.void),
        ),
      ),
    );
    const state = Context.get(
      await this.runtime.context(),
      HarnessSupervisorState,
    );
    const fiber = this.runtime.runFork(work);
    FiberMap.setUnsafe(state.fibers, task.invocationId, fiber, {
      onlyIfMissing: true,
    });
    return true;
  }

  has(invocationId: string): boolean {
    return this.entries.has(invocationId);
  }

  size(): number {
    return this.entries.size;
  }

  async complete(invocationId: string): Promise<void> {
    this.entries.get(invocationId)?.stop();
    await this.awaitEmptyIfStopped();
  }

  async drainAndJoin(): Promise<void> {
    for (const entry of this.entries.values()) entry.stop();
    await this.awaitEmpty();
  }

  async interruptAndJoin(): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* HarnessSupervisorState;
        yield* FiberMap.clear(state.fibers);
        yield* FiberMap.awaitEmpty(state.fibers);
      }),
    );
  }

  async interrupt(invocationId: string): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* HarnessSupervisorState;
        yield* FiberMap.remove(state.fibers, invocationId);
      }),
    );
  }

  async join(): Promise<void> {
    await this.awaitEmpty();
  }

  async close(force = false): Promise<void> {
    if (this.disposed) return;
    if (force) await this.interruptAndJoin();
    else await this.drainAndJoin();
    this.disposed = true;
    await this.runtime.dispose();
  }

  private async awaitEmptyIfStopped(): Promise<void> {
    await Promise.resolve();
    if (this.entries.size === 0) await this.awaitEmpty();
  }

  private async awaitEmpty(): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* HarnessSupervisorState;
        yield* FiberMap.awaitEmpty(state.fibers);
      }),
    );
  }
}
