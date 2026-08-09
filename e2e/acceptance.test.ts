import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  GitClient,
  HarnessWorkExecutor,
  HerdrClient,
  NodeCommandRunner,
  PiHarnessAdapter,
  RunEventStore,
  RunRuntime,
  RuntimeOwnershipStore,
  WorkflowScheduler,
  exportRun,
  importRun,
  type CommandOptions,
  type CommandRunner,
  type ProcessResult,
  type Workflow,
  type WorkExecutor,
} from "../packages/core/src/index.ts";
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CopilotHarnessAdapter,
} from "../packages/integrations/src/index.ts";

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
          '{"type":"message","usage":{"input_tokens":20,"output_tokens":5,"cost_usd":0.01}}\n',
        stderr: "",
      };
    return { code: 0, stdout: "{}", stderr: "" };
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

describe("disposable operational acceptance", () => {
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
    registry.register(new PiHarnessAdapter(new HerdrClient(herdrRunner)));
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
