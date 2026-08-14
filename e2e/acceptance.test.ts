import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  GitClient,
  HarnessWorkExecutor,
  HarnessProtocolStore,
  HerdrClient,
  NodeCommandRunner,
  PiHarnessAdapter,
  RunEventStore,
  produceDefaultPlanningArtifacts,
  RunRuntime,
  RuntimeOwnershipStore,
  WorkflowScheduler,
  exportRun,
  importRun,
  normalizedEvent,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterObservation,
  type AdapterResult,
  type AdapterValidation,
  type CommandOptions,
  type CommandRunner,
  type HarnessAdapter,
  type ProcessResult,
  type Workflow,
  type WorkExecutor,
} from "../packages/core/src/index.ts";
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CopilotHarnessAdapter,
} from "../packages/integrations/src/index.ts";
import { SwfService } from "../apps/service/src/server/swf-service.ts";

const directories: string[] = [];
const runId = "8c86919c-3569-4e97-9f09-1bba7b49ed3d";
const projectId = "37bf77bd-cfc8-46fe-92b0-ca5d6201c13b";

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class SimulatedHerdr implements CommandRunner {
  readonly workspaceId = `acceptance-${crypto.randomUUID()}`;
  readonly calls: string[] = [];

  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "which")
      return { code: 0, stdout: `/simulated/${args[0]}\n`, stderr: "" };
    if (args[0] === "integration")
      return { code: 0, stdout: "pi: installed\n", stderr: "" };
    if (args[0] === "workspace" && args[1] === "create")
      return {
        code: 0,
        stdout: JSON.stringify({
          workspace: { workspace_id: this.workspaceId },
        }),
        stderr: "",
      };
    if (args[0] === "worktree" && args[1] === "open")
      return {
        code: 0,
        stdout: JSON.stringify({
          worktree: { worktree_id: "acceptance-tree" },
        }),
        stderr: "",
      };
    if (args[0] === "tab" && args[1] === "create")
      return {
        code: 0,
        stdout: JSON.stringify({
          tab: { tab_id: "acceptance-tab" },
          pane: {
            pane_id: "acceptance-pane",
            terminal_id: "acceptance-terminal",
            process_id: "acceptance-process",
          },
        }),
        stderr: "",
      };
    if (args[0] === "pane" && args[1] === "get")
      return {
        code: 0,
        stdout: JSON.stringify({
          pane: { pane_id: "acceptance-pane", agent_status: "idle" },
        }),
        stderr: "",
      };
    if (args[0] === "pane" && args[1] === "read")
      return {
        code: 0,
        stdout:
          '{"type":"message","usage":{"input_tokens":20,"output_tokens":5,"cost_usd":0.01}}\n{"type":"turn_end"}\n',
        stderr: "",
      };
    return { code: 0, stdout: "{}", stderr: "" };
  }
}

class AcceptancePlanningAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly capabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: true,
    resume: false,
    usage: true,
  };
  async availability(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }
  async validate(): Promise<AdapterValidation> {
    return { valid: true, errors: [] };
  }
  async launch(request: AdapterLaunchRequest): Promise<AdapterInvocation> {
    const changeName = request.prompt.match(
      /OpenSpec change ([a-z][a-z0-9-]*)/,
    )?.[1];
    if (!changeName) throw new Error("Planning prompt omitted change identity");
    await produceDefaultPlanningArtifacts({
      changeRoot: join(request.cwd, "openspec", "changes", changeName),
      changeName,
      planning: {
        kind: "description",
        description: "CLI service acceptance planning",
      },
    });
    return {
      invocationId: crypto.randomUUID(),
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      paneId: "acceptance-pane",
      status: "completed",
      startedAt: new Date().toISOString(),
    };
  }
  async submit(): Promise<void> {}
  async observe(): Promise<AdapterObservation> {
    return { status: "completed", structuredEvents: [] };
  }
  async cancel(): Promise<void> {}
  async collect(): Promise<AdapterResult> {
    return {
      status: "completed",
      transcript: "acceptance planning completed",
      usage: { quality: "unknown" },
    };
  }
}

class SimulatedPiBridgeAdapter extends PiHarnessAdapter {
  override async launch(
    request: AdapterLaunchRequest,
  ): Promise<AdapterInvocation> {
    const invocation = await super.launch(request);
    const store = new HarnessProtocolStore(
      request.stateDirectory!,
      request.runId,
      invocation.invocationId,
    );
    const correlation = {
      projectId: request.projectId!,
      runId: request.runId,
      phaseId: request.phaseId,
      workUnitId: request.workUnitId,
      invocationId: invocation.invocationId,
      harness: "pi",
    };
    await store.appendNormalized(
      normalizedEvent({
        ...correlation,
        sourceCursor: "1",
        timestamp: new Date().toISOString(),
        type: "usage",
        required: false,
        sequence: 1,
        data: {},
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          costUsd: 0.01,
          quality: "exact",
        },
      }),
    );
    await store.appendNormalized(
      normalizedEvent({
        ...correlation,
        sourceCursor: "2",
        timestamp: new Date().toISOString(),
        type: "settled",
        required: true,
        sequence: 2,
        data: {},
      }),
    );
    return invocation;
  }
}

async function initializeRepository() {
  const root = await temporaryDirectory("swf-acceptance-repo-");
  const runner = new NodeCommandRunner();
  const git = async (args: string[]) => {
    const result = await runner.run("git", args, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr);
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "acceptance@example.test"]);
  await git(["config", "user.name", "SWF acceptance"]);
  await writeFile(join(root, "README.md"), "acceptance\n");
  await writeFile(join(root, ".gitignore"), ".swf-state/\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  return root;
}

async function configurePlanningFactory(root: string): Promise<void> {
  await mkdir(join(root, ".swf", "workflows"), { recursive: true });
  await mkdir(join(root, ".swf", "policies"), { recursive: true });
  await mkdir(join(root, ".swf", "profiles"), { recursive: true });
  await mkdir(join(root, ".swf", "guidelines"), { recursive: true });
  await mkdir(join(root, "openspec"), { recursive: true });
  await writeFile(
    join(root, ".swf", "config.yaml"),
    `schemaVersion: 1\nprojectId: ${projectId}\ndefaultWorkflow: default\ngit:\n  remote: origin\n  targetBranch: main\npaths:\n  state: .swf-state\n`,
  );
  await writeFile(
    join(root, ".swf", "workflows", "default.yaml"),
    `schemaVersion: 1\nid: default\ndescription: CLI service acceptance\nphases:\n  - id: planning\n    title: Planning\n    profile: planner\n    guidelines: []\n    requiredCapabilities: [structured-events]\n    work:\n      - id: planning-agent\n        type: agent\n        profile: planner\n        options: {}\n      - id: planning-command\n        type: command\n        command: test -f openspec/changes/*/proposal.md\n        options: {}\n    checks:\n      - id: planning-files\n        type: command\n        required: true\n        command: test -f openspec/changes/*/tasks.md\n        options: {}\n    gate:\n      mode: manual\n  - id: building\n    title: Building\n    profile: planner\n    guidelines: []\n    requiredCapabilities: []\n    work:\n      - id: building-command\n        type: command\n        command: test -f openspec/changes/*/proposal.md\n        options: {}\n    checks: []\n    gate:\n      mode: automatic\ndelivery:\n  mode: local-branch\n  mergeMethod: merge\n`,
  );
  await writeFile(
    join(root, ".swf", "policies", "manual.yaml"),
    `schemaVersion: 1\nid: manual\napprovalMode: manual\nmaxAttempts: 1\nriskOverrides: []\n`,
  );
  await writeFile(
    join(root, ".swf", "policies", "autonomous.yaml"),
    `schemaVersion: 1\nid: autonomous\napprovalMode: automatic\nmaxAttempts: 1\nriskOverrides: []\n`,
  );
  await writeFile(
    join(root, ".swf", "profiles", "planner.yaml"),
    `schemaVersion: 1\nid: planner\ndescription: Acceptance planner\nharness: pi\nguidelines: []\ncapabilities: [structured-events]\noptions: {}\n`,
  );
  await writeFile(
    join(root, "openspec", "config.yaml"),
    "schema: spec-driven\n",
  );
  const runner = new NodeCommandRunner();
  for (const args of [
    ["add", "."],
    ["commit", "-m", "configure SWF"],
  ]) {
    const result = await runner.run("git", args, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr);
  }
}

describe("disposable operational acceptance", () => {
  it("executes swf new through the authenticated service API and stops after Planning", async () => {
    const root = await initializeRepository();
    await configurePlanningFactory(root);
    const serviceHome = await temporaryDirectory("swf-acceptance-service-");
    const serviceRef: { current?: SwfService } = {};
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      try {
        const service = serviceRef.current;
        if (!service) throw new Error("Acceptance service is not ready");
        const credential = request.headers.authorization?.replace(
          /^Bearer /,
          "",
        );
        service.authenticate(credential);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >)
          : {};
        let result: unknown;
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/api/v1/projects") {
          result = await service.registerProject({
            projectId: String(body.projectId),
            displayName: String(body.displayName),
            root: String(body.root),
          });
        } else if (requestUrl.pathname === "/api/v1/commands") {
          result = await service.command(body as never);
        } else if (requestUrl.pathname === "/api/v1/query") {
          result = await service.query({
            resource: requestUrl.searchParams.get("resource") as never,
            projectId: requestUrl.searchParams.get("projectId") ?? undefined,
            runId: requestUrl.searchParams.get("runId") ?? undefined,
            phaseId: requestUrl.searchParams.get("phaseId") ?? undefined,
            ref: requestUrl.searchParams.get("ref") ?? undefined,
          });
        } else {
          response.statusCode = 404;
          throw new Error("Not found");
        }
        response.end(JSON.stringify({ schemaVersion: 1, result }));
      } catch (error) {
        response.statusCode ||= 400;
        response.end(
          JSON.stringify({
            statusMessage:
              error instanceof Error ? error.message : "request failed",
          }),
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Acceptance HTTP server did not bind");
    const service = new SwfService({
      serviceHome,
      endpoint: `http://127.0.0.1:${address.port}`,
      projectTrust: async () => true,
      harnessAdapters: [new AcceptancePlanningAdapter()],
      herdrClient: new HerdrClient(new SimulatedHerdr()),
      commandRunner: new NodeCommandRunner(),
    });
    serviceRef.current = service;
    await service.start();

    try {
      const repositoryRoot = process.cwd();
      const explored = await new NodeCommandRunner().run(
        process.execPath,
        [
          "--import",
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/loader.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "explore",
          "start",
          "Exercise Planning through CLI and service",
          "--candidate",
          "cli-service-entry",
          "--json",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome, CONSOLA_LEVEL: "5" },
          timeoutMs: 30_000,
        },
      );
      expect(explored.code, explored.stderr).toBe(0);
      const explorationId = (
        JSON.parse(explored.stdout) as {
          result: { exploration: { explorationId: string } };
        }
      ).result.exploration.explorationId;
      const cli = await new NodeCommandRunner().run(
        process.execPath,
        [
          "--import",
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/loader.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "new",
          "cli-service-entry",
          "--from-exploration",
          explorationId,
          "--json",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome },
          timeoutMs: 30_000,
        },
      );
      expect(cli.code, cli.stderr).toBe(0);
      const output = JSON.parse(cli.stdout) as {
        schemaVersion: number;
        result: { runId: string; status: string };
      };
      expect(output).toMatchObject({
        schemaVersion: 1,
        result: {
          status: "blocked",
          projection: {
            stoppingPhaseId: "planning",
            attention: [{ type: "manual-approval" }],
          },
        },
      });
      const humanStatus = await new NodeCommandRunner().run(
        process.execPath,
        [
          "--import",
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/loader.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "status",
          "cli-service-entry",
          "--no-interactive",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome, CONSOLA_LEVEL: "5" },
          timeoutMs: 30_000,
        },
      );
      expect(humanStatus.code, humanStatus.stderr).toBe(0);
      expect(humanStatus.stdout).toContain("Approval required: planning");
      expect(humanStatus.stdout).toContain("swf approve cli-service-entry");

      const approved = await new NodeCommandRunner().run(
        process.execPath,
        [
          "--import",
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/loader.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "approve",
          "cli-service-entry",
          "--actor",
          "acceptance-operator",
          "--reason",
          "Planning evidence reviewed",
          "--no-interactive",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome, CONSOLA_LEVEL: "5" },
          timeoutMs: 30_000,
        },
      );
      expect(approved.code, approved.stderr).toBe(0);
      expect(approved.stdout).toContain("planning completed");
      const run = (await service.query({
        resource: "run",
        projectId,
        runId: output.result.runId,
      })) as {
        state: {
          phases: { planning: { status: string } };
          checkpoints: Record<string, unknown>;
        };
      };
      expect(run.state.phases.planning.status).toBe("completed");
      expect(Object.keys(run.state.checkpoints)).toHaveLength(1);

      const next = await new NodeCommandRunner().run(
        process.execPath,
        [
          "--import",
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/loader.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "next",
          "cli-service-entry",
          "--no-interactive",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome, CONSOLA_LEVEL: "5" },
          timeoutMs: 30_000,
        },
      );
      expect(next.code, next.stderr).toBe(0);
      expect(next.stdout).toContain("cli-service-entry completed");

      const automatic = await new NodeCommandRunner().run(
        process.execPath,
        [
          join(repositoryRoot, "apps/cli/node_modules/tsx/dist/cli.mjs"),
          join(repositoryRoot, "apps/cli/src/main.ts"),
          "run",
          "automatic-entry",
          "--description",
          "Run every eligible phase",
          "--policy",
          "autonomous",
          "--authorize-autonomous",
          "--json",
        ],
        {
          cwd: root,
          env: { SWF_SERVICE_HOME: serviceHome },
          timeoutMs: 30_000,
        },
      );
      expect(automatic.code, automatic.stderr).toBe(0);
      const automaticOutput = JSON.parse(automatic.stdout) as {
        result: { runId: string; changeName: string; status: string };
      };
      expect(automaticOutput).toMatchObject({
        result: { changeName: "automatic-entry", status: "completed" },
      });
      const automaticRun = (await service.query({
        resource: "run",
        projectId,
        runId: automaticOutput.result.runId,
      })) as { runtime: { worktreePath: string } };
      await expect(
        stat(
          join(
            automaticRun.runtime.worktreePath,
            "openspec",
            "changes",
            "automatic-entry",
            "evidence",
            "dossier.json",
          ),
        ),
      ).resolves.toBeDefined();
    } finally {
      await service.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("runs a simulated model in an isolated Herdr worktree and transfers its complete history", async () => {
    const root = await initializeRepository();
    const stateDirectory = join(root, ".swf-state");
    const store = new RunEventStore(stateDirectory);
    await store.create({
      projectId,
      runId,
      changeName: "acceptance-change",
      changeIdentity: "changes/acceptance-change",
      workflowId: "acceptance",
      description: "Acceptance workflow",
      phaseIds: ["building"],
    });
    await store.append(runId, {
      type: "run.transitioned",
      actor: { type: "service", id: "acceptance" },
      context: {},
      data: { from: "pending", to: "running" },
    });

    const herdrRunner = new SimulatedHerdr();
    const runtime = new RunRuntime(
      new GitClient(root),
      new HerdrClient(herdrRunner),
      new RuntimeOwnershipStore(stateDirectory),
    );
    const prepared = await runtime.prepare({ runId, stateDirectory });
    const registry = new AdapterRegistry();
    registry.register(
      new SimulatedPiBridgeAdapter(new HerdrClient(herdrRunner)),
    );
    const fallback: WorkExecutor = {
      execute: async (unit) => {
        await writeFile(
          join(prepared.worktree.path, `${unit.id}.txt`),
          "done\n",
        );
        return { status: "completed" };
      },
    };
    const workflow: Workflow = {
      schemaVersion: 1,
      id: "acceptance",
      description: "Simulated acceptance",
      phases: [
        {
          id: "building",
          title: "Building",
          profile: "builder",
          guidelines: [],
          requiredCapabilities: ["structured-events", "usage"],
          work: [
            {
              id: "model-work",
              type: "agent",
              options: { prompt: "Produce the acceptance result" },
            },
            { id: "command-work", type: "command", options: {} },
          ],
          checks: [],
          gate: { mode: "automatic" },
        },
      ],
      delivery: { mode: "local-branch", mergeMethod: "merge" },
    };
    const scheduler = new WorkflowScheduler(
      workflow,
      new HarnessWorkExecutor(
        registry,
        {
          projectId,
          stateDirectory,
          runId,
          workspaceId: prepared.workspaceId,
          cwd: prepared.worktree.path,
          afterCollect: async (invocation, result) => {
            await store.append(runId, {
              type: "invocation.recorded",
              actor: { type: "harness", id: "pi" },
              context: {
                phaseId: invocation.phaseId,
                invocationId: invocation.invocationId,
              },
              data: {
                invocation: {
                  schemaVersion: 1,
                  invocationId: invocation.invocationId,
                  runId,
                  phaseId: invocation.phaseId,
                  harness: "pi",
                  status: "completed",
                  startedAt: invocation.startedAt,
                  endedAt: new Date().toISOString(),
                  cost: {
                    amountUsd: result.usage.costUsd,
                    quality: result.usage.quality,
                  },
                  usage: result.usage,
                },
              },
            });
          },
        },
        fallback,
      ),
    );
    const result = await scheduler.executePhase(
      "building",
      { eligible: true, reasons: [] },
      { project: { harness: "pi" } },
    );
    expect(result.status).toBe("completed");
    expect(await new GitClient(prepared.worktree.path).isClean()).toBe(false);
    expect(herdrRunner.workspaceId).toMatch(/^acceptance-/);

    await store.append(runId, {
      type: "run.transitioned",
      actor: { type: "service", id: "acceptance" },
      context: {},
      data: { from: "running", to: "completed" },
    });
    const archive = await exportRun(stateDirectory, runId);
    const restored = await temporaryDirectory("swf-acceptance-import-");
    await importRun(restored, archive);
    const imported = await new RunEventStore(restored).load(runId);
    expect(imported.state.run.status).toBe("completed");
    expect(
      Object.values(imported.state.invocations)[0]?.usage?.totalTokens,
    ).toBe(25);
  });
});

const live = process.env.SWF_LIVE_HARNESS_SMOKE === "1";
describe.skipIf(!live)("selected live harness smoke", () => {
  it("checks the explicitly selected authenticated adapter and Herdr integration", async () => {
    const herdr = new HerdrClient();
    const adapters = {
      pi: new PiHarnessAdapter(herdr),
      codex: new CodexHarnessAdapter(herdr),
      claude: new ClaudeHarnessAdapter(herdr),
      copilot: new CopilotHarnessAdapter(herdr),
    };
    const selected = process.env.SWF_LIVE_HARNESS as keyof typeof adapters;
    expect(selected).toMatch(/^(pi|codex|claude|copilot)$/);
    await expect(adapters[selected].availability()).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });
});
