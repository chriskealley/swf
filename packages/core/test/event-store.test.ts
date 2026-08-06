import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateRunError,
  RunEventStore,
  createRunEvent,
  createRunState,
  parseRunEvent,
  reduceRunState,
} from "../src/index.js";

const directories: string[] = [];
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";

async function createStore(): Promise<RunEventStore> {
  const directory = await mkdtemp(join(tmpdir(), "swf-events-"));
  directories.push(directory);
  return new RunEventStore(directory);
}

async function createRun(store: RunEventStore) {
  return store.create({
    projectId,
    runId,
    changeName: "add-user-auth",
    changeIdentity: "changes/add-user-auth#2026-04-02",
    workflowId: "default",
    description: "Add token authentication",
    phaseIds: ["planning", "building"],
    createdAt: "2026-04-02T12:00:00.000Z",
  });
}

const systemActor = { type: "system" as const, id: "swf" };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("domain reducers", () => {
  it("only accepts legal run and phase state transitions", () => {
    const run = {
      schemaVersion: 1 as const,
      runId,
      projectId,
      changeName: "add-user-auth",
      changeIdentity: "changes/add-user-auth#2026-04-02",
      workflowId: "default",
      phaseIds: ["planning"],
      description: "Add token authentication",
      status: "pending" as const,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
    };
    let state = createRunState(run);
    state = reduceRunState(
      state,
      createRunEvent({
        runId,
        sequence: 0,
        type: "run.created",
        actor: systemActor,
        context: {},
        data: { changeIdentity: run.changeIdentity },
      }),
    );
    state = reduceRunState(
      state,
      createRunEvent({
        runId,
        sequence: 1,
        type: "run.transitioned",
        actor: systemActor,
        context: {},
        data: { from: "pending", to: "running" },
      }),
    );
    state = reduceRunState(
      state,
      createRunEvent({
        runId,
        sequence: 2,
        type: "phase.transitioned",
        actor: systemActor,
        context: { phaseId: "planning" },
        data: { phaseId: "planning", from: "pending", to: "running" },
      }),
    );
    state = reduceRunState(
      state,
      createRunEvent({
        runId,
        sequence: 3,
        type: "phase.transitioned",
        actor: systemActor,
        context: { phaseId: "planning" },
        data: { phaseId: "planning", from: "running", to: "completed" },
      }),
    );
    expect(state.run.status).toBe("running");
    expect(state.phases.planning?.status).toBe("completed");

    expect(() =>
      reduceRunState(
        state,
        createRunEvent({
          runId,
          sequence: 4,
          type: "phase.transitioned",
          actor: systemActor,
          context: { phaseId: "planning" },
          data: { phaseId: "planning", from: "completed", to: "failed" },
        }),
      ),
    ).toThrow("Illegal phase planning transition");
  });

  it("keeps retries, reruns, remediation, resets, and rollbacks in the same run attempt history", () => {
    const run = {
      schemaVersion: 1 as const,
      runId,
      projectId,
      changeName: "add-user-auth",
      changeIdentity: "changes/add-user-auth#2026-04-02",
      workflowId: "default",
      phaseIds: ["planning"],
      description: "Add token authentication",
      status: "pending" as const,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
    };
    let state = createRunState(run);
    const apply = (event: ReturnType<typeof createRunEvent>) => {
      state = reduceRunState(state, event);
    };
    apply(
      createRunEvent({
        runId,
        sequence: 0,
        type: "run.created",
        actor: systemActor,
        context: {},
        data: { changeIdentity: run.changeIdentity },
      }),
    );
    const lifecycle = [
      ["run.retried", "retry", "67ca1f2b-4f73-4eea-908b-cbe8d21805a1"],
      ["phase.rerun", "rerun", "c34fe2d7-2239-4adc-ae92-1ce0f622c2ce"],
      ["run.remediated", "remediation", "24eec438-ed0f-4392-8e81-70291bdc3d01"],
      ["run.reset", "reset", "c27c5128-4ca8-45d8-b36f-21e0d8195da2"],
    ] as const;
    let sequence = 1;
    for (const [type, kind, attemptId] of lifecycle) {
      apply(
        createRunEvent({
          runId,
          sequence: sequence++,
          type: "attempt.started",
          actor: systemActor,
          context: { phaseId: "planning", attemptId },
          data: { attemptId, phaseId: "planning", number: sequence, kind },
        }),
      );
      apply(
        createRunEvent({
          runId,
          sequence: sequence++,
          type,
          actor: systemActor,
          context: { phaseId: "planning", attemptId },
          data: { phaseId: "planning", attemptId },
        }),
      );
    }
    const checkpointId = "d1e83fa6-c01d-42ef-86c6-dd7c2db5eac4";
    apply(
      createRunEvent({
        runId,
        sequence: sequence++,
        type: "checkpoint.recorded",
        actor: systemActor,
        context: { phaseId: "planning" },
        data: {
          checkpoint: {
            schemaVersion: 1,
            checkpointId,
            runId,
            phaseId: "planning",
            beforeCommit: "abc",
            afterCommit: "def",
            createdAt: "2026-04-02T12:00:01.000Z",
            logical: false,
            artifactIds: [],
            changedFiles: [],
            clean: true,
          },
        },
      }),
    );
    const rollbackAttemptId = "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133";
    apply(
      createRunEvent({
        runId,
        sequence: sequence++,
        type: "attempt.started",
        actor: systemActor,
        context: { phaseId: "planning", attemptId: rollbackAttemptId },
        data: {
          attemptId: rollbackAttemptId,
          phaseId: "planning",
          number: sequence,
          kind: "rollback",
        },
      }),
    );
    apply(
      createRunEvent({
        runId,
        sequence,
        type: "run.rolled-back",
        actor: systemActor,
        context: { phaseId: "planning", attemptId: rollbackAttemptId },
        data: {
          checkpointId,
          phaseId: "planning",
          attemptId: rollbackAttemptId,
        },
      }),
    );

    expect(
      Object.values(state.attempts).map((attempt) => attempt.kind),
    ).toEqual(["retry", "rerun", "remediation", "reset", "rollback"]);
    expect(state.lastSequence).toBe(sequence);
  });

  it("validates typed immutable event payloads", () => {
    const event = createRunEvent({
      runId,
      sequence: 0,
      type: "run.created",
      actor: systemActor,
      context: {},
      data: { changeIdentity: "changes/add-user-auth#2026-04-02" },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(() =>
      parseRunEvent({
        ...event,
        type: "run.transitioned",
        data: { from: "pending", to: "not-a-status" },
      }),
    ).toThrow();
  });
});

describe("append-only run event storage", () => {
  it("creates one immutable run binding and rejects a duplicate", async () => {
    const store = await createStore();
    const run = await createRun(store);
    expect(run.changeIdentity).toBe("changes/add-user-auth#2026-04-02");
    await expect(createRun(store)).rejects.toBeInstanceOf(DuplicateRunError);
    await expect(
      store.findRunByChangeIdentity(run.changeIdentity!),
    ).resolves.toBe(runId);
  });

  it("serializes concurrent appends and provides idempotency", async () => {
    const store = await createStore();
    await createRun(store);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(runId, {
          type: "check.recorded",
          actor: systemActor,
          context: { phaseId: "planning", checkId: `check-${index}` },
          idempotencyKey: `check-${index}`,
          data: {
            checkId: `check-${index}`,
            phaseId: "planning",
            status: "passed",
          },
        }),
      ),
    );
    const exactEvent = {
      eventId: "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133",
      type: "check.recorded" as const,
      actor: systemActor,
      context: { phaseId: "planning", checkId: "exactly-once" },
      idempotencyKey: "exactly-once",
      data: {
        checkId: "exactly-once",
        phaseId: "planning",
        status: "passed" as const,
      },
    };
    expect((await store.append(runId, exactEvent)).appended).toBe(true);
    const duplicate = await store.append(runId, exactEvent);

    expect(duplicate.appended).toBe(false);
    expect(
      (await store.readEvents(runId)).map((event) => event.sequence),
    ).toEqual(Array.from({ length: 22 }, (_, index) => index));
  });

  it("replays run metadata and events when snapshots are missing, stale, or corrupt", async () => {
    const store = await createStore();
    await createRun(store);
    await store.append(runId, {
      type: "run.transitioned",
      actor: systemActor,
      context: {},
      data: { from: "pending", to: "running" },
    });
    expect((await store.load(runId)).snapshot.status).toBe("missing");
    expect((await store.load(runId)).state.run.status).toBe("running");

    await store.rebuildSnapshot(runId);
    expect((await store.load(runId)).snapshot.status).toBe("fresh");
    await store.append(runId, {
      type: "check.recorded",
      actor: systemActor,
      context: { phaseId: "planning", checkId: "follow-up" },
      data: { checkId: "follow-up", phaseId: "planning", status: "passed" },
    });
    expect((await store.load(runId)).snapshot.status).toBe("stale");

    await writeFile(
      join(
        (store as { stateDirectory: string }).stateDirectory,
        "runs",
        runId,
        "snapshot.json",
      ),
      "not json",
      "utf8",
    );
    const loaded = await store.load(runId);
    expect(loaded.snapshot.status).toBe("corrupt");
    expect(loaded.state.run.status).toBe("running");
  });

  it("recovers from an interrupted trailing JSONL write without accepting mid-stream corruption", async () => {
    const store = await createStore();
    await createRun(store);
    await store.append(runId, {
      type: "run.transitioned",
      actor: systemActor,
      context: {},
      data: { from: "pending", to: "running" },
    });
    const eventPath = join(
      (store as { stateDirectory: string }).stateDirectory,
      "runs",
      runId,
      "events.jsonl",
    );
    await appendFile(
      eventPath,
      '{"schemaVersion":1,"eventId":"interrupted"',
      "utf8",
    );

    expect((await store.load(runId)).state.run.status).toBe("running");
    await store.append(runId, {
      type: "check.recorded",
      actor: systemActor,
      context: { phaseId: "planning", checkId: "recovered" },
      data: { checkId: "recovered", phaseId: "planning", status: "passed" },
    });
    expect(
      (await store.readEvents(runId)).map((event) => event.sequence),
    ).toEqual([0, 1, 2]);
  });
});
