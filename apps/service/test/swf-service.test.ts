import { mkdir, realpath, rm, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunEventStore,
  type AdapterInvocation,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type HarnessAdapter,
} from "@swf/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ServiceAlreadyRunningError,
  ServiceAuthenticationError,
  SwfService,
} from "../src/server/swf-service.js";

const directories: string[] = [];
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), prefix)),
  );
  directories.push(directory);
  return directory;
}

async function setup(): Promise<{ service: SwfService; projectRoot: string }> {
  const home = await temporaryDirectory("swf-service-");
  const projectRoot = await temporaryDirectory("swf-service-project-");
  await mkdir(join(projectRoot, ".git"));
  await mkdir(join(projectRoot, ".swf"));
  const service = new SwfService({
    serviceHome: home,
    endpoint: "http://127.0.0.1:45001",
  });
  await service.start();
  await service.registerProject({
    projectId,
    displayName: "Test project",
    root: projectRoot,
  });
  return { service, projectRoot };
}

async function createRun(projectRoot: string): Promise<void> {
  const store = new RunEventStore(join(projectRoot, ".swf-state"));
  await store.create({
    projectId,
    runId,
    changeName: "add-user-auth",
    changeIdentity: "changes/add-user-auth#2026-04-02",
    workflowId: "default",
    description: "Add token authentication",
    phaseIds: ["planning"],
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-scoped SWF service", () => {
  it("owns a user scope with private endpoint metadata and credentials", async () => {
    const home = await temporaryDirectory("swf-service-");
    const service = new SwfService({
      serviceHome: home,
      endpoint: "http://127.0.0.1:45001",
    });
    const metadata = await service.start();
    const competing = new SwfService({
      serviceHome: home,
      endpoint: "http://127.0.0.1:45002",
    });

    expect(metadata.endpoint).toBe("http://127.0.0.1:45001");
    expect(metadata.credential).not.toHaveLength(0);
    expect((await stat(join(home, "service.json"))).mode & 0o777).toBe(0o600);
    await expect(competing.start()).rejects.toBeInstanceOf(
      ServiceAlreadyRunningError,
    );
    expect(() => service.authenticate("wrong-token")).toThrow(
      ServiceAuthenticationError,
    );
    expect(() => service.authenticate(metadata.credential)).not.toThrow();
    await service.shutdown();
  });

  it("reconciles moved and unavailable project roots without copying project state", async () => {
    const { service, projectRoot } = await setup();
    const canonicalProjectRoot = await realpath(projectRoot);
    const movedRoot = `${projectRoot}-moved`;
    await rename(projectRoot, movedRoot);
    const moved = await service.registerProject({
      projectId,
      displayName: "Renamed project",
      root: movedRoot,
    });
    expect(moved.previousRoots).toContain(canonicalProjectRoot);
    await rm(movedRoot, { recursive: true });

    const [unavailable] = await service.reconcileProjects();
    expect(unavailable).toMatchObject({
      projectId,
      availability: "unavailable",
    });
    await service.shutdown();
  });

  it("provides authenticated project and run queries plus lifecycle commands", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);

    await expect(service.query({ resource: "projects" })).resolves.toHaveLength(
      1,
    );
    await expect(
      service.query({ resource: "runs", projectId }),
    ).resolves.toHaveLength(1);
    await service.command({ type: "start", projectId, runId });
    await service.command({ type: "pause", projectId, runId });
    await service.command({ type: "resume", projectId, runId });
    await service.command({
      type: "reject",
      projectId,
      runId,
      phaseId: "planning",
      gateId: "planning-gate",
      actorId: "operator",
      reason: "needs changes",
    });
    await service.command({
      type: "approve",
      projectId,
      runId,
      phaseId: "planning",
      gateId: "planning-gate",
      actorId: "operator",
    });
    await service.command({
      type: "remediate",
      projectId,
      runId,
      phaseId: "planning",
      reason: "fix failing test",
    });
    const store = new RunEventStore(join(projectRoot, ".swf-state"));
    await store.append(runId, {
      type: "checkpoint.recorded",
      actor: { type: "service", id: "test" },
      context: { phaseId: "planning" },
      data: {
        checkpoint: {
          schemaVersion: 1,
          checkpointId: "d1e83fa6-c01d-42ef-86c6-dd7c2db5eac4",
          runId,
          phaseId: "planning",
          beforeCommit: "abc",
          afterCommit: "def",
          createdAt: "2026-04-02T12:00:01.000Z",
          logical: false,
        },
      },
    });
    await service.command({
      type: "rollback",
      projectId,
      runId,
      phaseId: "planning",
      checkpointId: "d1e83fa6-c01d-42ef-86c6-dd7c2db5eac4",
    });
    await service.command({ type: "cancel", projectId, runId });

    const run = (await service.query({
      resource: "run",
      projectId,
      runId,
    })) as {
      state: {
        run: { status: string };
        phases: Record<string, { gate?: { status: string } }>;
        attempts: Record<string, unknown>;
      };
    };
    expect(run.state.run.status).toBe("cancelled");
    expect(run.state.phases.planning?.gate?.status).toBe("satisfied");
    expect(Object.keys(run.state.attempts)).toHaveLength(2);
    await expect(
      service.query({ resource: "costs", projectId, runId }),
    ).resolves.toEqual({ exactUsd: 0, estimatedUsd: 0, unknown: 0 });
    await service.shutdown();
  });

  it("routes blocked agent input through the service to its recorded owned invocation", async () => {
    const { service } = await setup();
    const submitted: string[] = [];
    const adapter: HarnessAdapter = {
      id: "fake",
      capabilities: {
        structuredEvents: true,
        modelSelection: false,
        toolSelection: false,
        cancellation: true,
        blockedInput: true,
        resume: false,
        usage: false,
      },
      availability: async (): Promise<AdapterValidation> => ({
        valid: true,
        errors: [],
      }),
      validate: async (): Promise<AdapterValidation> => ({
        valid: true,
        errors: [],
      }),
      launch: async (): Promise<AdapterInvocation> => {
        throw new Error("not used");
      },
      submit: async (_invocation, response) => {
        submitted.push(response);
      },
      observe: async (): Promise<AdapterObservation> => ({
        status: "blocked",
        structuredEvents: [],
      }),
      cancel: async () => undefined,
      collect: async (): Promise<AdapterResult> => ({
        status: "completed",
        transcript: "",
        usage: { quality: "unknown" },
      }),
    };
    const invocation: AdapterInvocation = {
      invocationId: "b49d10b4-8aa7-4e10-9018-e5e9d1a9c133",
      runId,
      phaseId: "planning",
      workUnitId: "agent",
      paneId: "p1",
      status: "blocked",
      startedAt: "2026-04-02T12:00:00.000Z",
    };
    service.reportBlockedAgent(adapter, invocation, {
      status: "blocked",
      blockedPrompt: "Choose",
      structuredEvents: [],
    });
    await expect(
      service.query({ resource: "blocked-inputs" }),
    ).resolves.toMatchObject([{ invocationId: invocation.invocationId }]);
    await service.command({
      type: "blocked-input",
      invocationId: invocation.invocationId,
      response: "Continue",
    });
    expect(submitted).toEqual(["Continue"]);
    await service.shutdown();
  });

  it("replays ordered events to reconnecting subscribers", async () => {
    const home = await temporaryDirectory("swf-service-");
    const service = new SwfService({ serviceHome: home });
    await service.start();
    const first = service.subscribe();
    const started = await first[Symbol.asyncIterator]().next();
    expect(started.value?.type).toBe("service.started");

    const second = service.subscribe(started.value!.id);
    const secondIterator = second[Symbol.asyncIterator]();
    const projectRoot = await temporaryDirectory("swf-service-project-");
    await mkdir(join(projectRoot, ".git"));
    await service.registerProject({
      projectId,
      displayName: "Test project",
      root: projectRoot,
    });
    const update = await secondIterator.next();
    expect(update.value).toMatchObject({
      id: started.value!.id + 1,
      type: "project.registered",
      projectId,
    });
    first.close();
    second.close();
    expect((await secondIterator.next()).done).toBe(true);
    await service.shutdown();
  });

  it("drains safe work then pauses runs, and force shutdown interrupts only owned work", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await service.command({ type: "start", projectId, runId });
    let reachBoundary: () => void = () => undefined;
    const safeBoundary = new Promise<void>((resolve) => {
      reachBoundary = resolve;
    });
    service.registerActiveWork({
      projectId,
      runId,
      safeBoundary,
      interrupt: async () => undefined,
    });
    const graceful = service.shutdown();
    expect(service.status).toBe("draining");
    reachBoundary();
    await graceful;
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("paused");

    const forceHome = await temporaryDirectory("swf-service-force-");
    const forceService = new SwfService({ serviceHome: forceHome });
    await forceService.start();
    await forceService.registerProject({
      projectId,
      displayName: "Test project",
      root: projectRoot,
    });
    await forceService.command({ type: "resume", projectId, runId });
    let interrupted = false;
    forceService.registerActiveWork({
      projectId,
      runId,
      safeBoundary: new Promise(() => undefined),
      interrupt: async () => {
        interrupted = true;
      },
    });
    await forceService.shutdown({ force: true });
    expect(interrupted).toBe(true);
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("paused");
  });

  it("recovers active durable runs through a reconciliation hook", async () => {
    const { service, projectRoot } = await setup();
    await createRun(projectRoot);
    await service.command({ type: "start", projectId, runId });
    await service.shutdown({ force: true });

    const recovered = new SwfService({ serviceHome: service.serviceHome });
    await recovered.start();
    await recovered.command({ type: "resume", projectId, runId });
    await recovered.recover(async () => ({
      action: "block",
      reason: "owned pane is missing",
    }));
    expect(
      (await new RunEventStore(join(projectRoot, ".swf-state")).load(runId))
        .state.run.status,
    ).toBe("blocked");
    await recovered.shutdown();
  });
});
