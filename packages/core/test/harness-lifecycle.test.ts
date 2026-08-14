import { describe, expect, it } from "vitest";
import { HarnessLifecycleSupervisor } from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Effect harness lifecycle supervision", () => {
  it("keeps blocked work addressable until natural settlement", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    const settled = deferred();
    let finalizations = 0;
    await supervisor.supervise({
      invocationId: "blocked",
      run: async () => settled.promise,
      interrupt: async () => undefined,
      finalize: async () => {
        finalizations += 1;
      },
    });
    expect(supervisor.has("blocked")).toBe(true);
    settled.resolve();
    await supervisor.join();
    expect(supervisor.has("blocked")).toBe(false);
    expect(finalizations).toBe(1);
    await supervisor.close();
  });

  it("gracefully drains without cancellation and finalizes exactly once", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    let interruptions = 0;
    let finalizations = 0;
    await supervisor.supervise({
      invocationId: "graceful",
      run: async (signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
      interrupt: async () => {
        interruptions += 1;
      },
      finalize: async () => {
        finalizations += 1;
      },
    });
    await supervisor.close(false);
    expect(interruptions).toBe(0);
    expect(finalizations).toBe(1);
  });

  it("force interruption cancels, joins, and finalizes exactly once", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    let interruptions = 0;
    let finalizations = 0;
    await supervisor.supervise({
      invocationId: "forced",
      run: async (signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
      interrupt: async () => {
        interruptions += 1;
      },
      finalize: async () => {
        finalizations += 1;
      },
    });
    await supervisor.close(true);
    expect(interruptions).toBe(1);
    expect(finalizations).toBe(1);
  });

  it("interrupts an Effect-scheduled polling lifecycle", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    let interruptions = 0;
    await supervisor.supervisePolling({
      invocationId: "polling",
      intervalMs: 60_000,
      poll: async () => "continue",
      interrupt: async () => {
        interruptions += 1;
      },
    });
    await supervisor.close(true);
    expect(interruptions).toBe(1);
  });

  it("continues scheduled polling until an explicit terminal result", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    let polls = 0;
    await supervisor.supervisePolling({
      invocationId: "poll-until-done",
      intervalMs: 1,
      poll: async () => (++polls === 3 ? "done" : "continue"),
      interrupt: async () => undefined,
    });
    await supervisor.join();
    expect(polls).toBe(3);
    await supervisor.close();
  });

  it("continues after blocked input and stops all writes before drain returns", async () => {
    const supervisor = new HarnessLifecycleSupervisor();
    let continued = false;
    let polls = 0;
    await supervisor.supervisePolling({
      invocationId: "blocked-continuation",
      intervalMs: 1,
      poll: async () => {
        polls += 1;
        return continued ? "done" : "continue";
      },
      interrupt: async () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(supervisor.has("blocked-continuation")).toBe(true);
    continued = true;
    await supervisor.join();
    expect(polls).toBeGreaterThan(1);
    await supervisor.close();

    const drained = new HarnessLifecycleSupervisor();
    let writes = 0;
    await drained.supervisePolling({
      invocationId: "no-late-writes",
      intervalMs: 1,
      poll: async () => {
        writes += 1;
        return "continue";
      },
      interrupt: async () => undefined,
    });
    await drained.close(false);
    const atDrain = writes;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(atDrain);
  });
});
