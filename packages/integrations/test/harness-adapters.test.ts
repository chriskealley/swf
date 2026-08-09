import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  HarnessWorkExecutor,
  HerdrClient,
  WorkflowScheduler,
  assertAdapterConformance,
  type AdapterLaunchRequest,
  type CommandOptions,
  type CommandRunner,
  type ProcessResult,
  type Workflow,
} from "@swf/core";
import {
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CopilotHarnessAdapter,
} from "../src/index.js";

class HarnessRunner implements CommandRunner {
  readonly calls: string[] = [];
  transcript = "";

  async run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<ProcessResult> {
    const call = `${command} ${args.join(" ")}`;
    this.calls.push(call);
    if (command === "which")
      return { code: 0, stdout: `/bin/${args[0]}\n`, stderr: "" };
    if (command === "codex" && args.join(" ") === "login status")
      return { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
    if (command === "claude" && args.slice(0, 2).join(" ") === "auth status")
      return {
        code: 0,
        stdout: '{"loggedIn":true,"authMethod":"oauth"}\n',
        stderr: "",
      };
    if (command !== "herdr") return { code: 0, stdout: "", stderr: "" };
    if (args.slice(0, 2).join(" ") === "integration status")
      return {
        code: 0,
        stdout: "codex: installed\nclaude: installed\ncopilot: installed\n",
        stderr: "",
      };
    if (args.slice(0, 2).join(" ") === "tab create")
      return {
        code: 0,
        stdout:
          '{"tab":{"tab_id":"t1"},"pane":{"pane_id":"p1","terminal_id":"term1"}}',
        stderr: "",
      };
    if (args.slice(0, 2).join(" ") === "pane run") {
      const launched = args.at(-1) ?? "";
      if (launched.includes("codex"))
        this.transcript =
          '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}\n';
      else if (launched.includes("claude"))
        this.transcript =
          '{"type":"system","subtype":"init","session_id":"550e8400-e29b-41d4-a716-446655440000"}\n{"type":"result","session_id":"550e8400-e29b-41d4-a716-446655440000","usage":{"input_tokens":8,"output_tokens":3},"total_cost_usd":0.02}\n';
      else if (launched.includes("copilot"))
        this.transcript =
          "Session ID: 660e8400-e29b-41d4-a716-446655440000\nDone\n";
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args.slice(0, 2).join(" ") === "wait agent-status")
      return { code: 0, stdout: "{}", stderr: "" };
    if (args.slice(0, 2).join(" ") === "pane get")
      return {
        code: 0,
        stdout: '{"pane":{"pane_id":"p1","agent_status":"done"}}',
        stderr: "",
      };
    if (args.slice(0, 2).join(" ") === "pane read")
      return { code: 0, stdout: this.transcript, stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  }
}

function request(
  overrides: Partial<AdapterLaunchRequest> = {},
): AdapterLaunchRequest {
  return {
    runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
    phaseId: "building",
    workUnitId: "agent",
    workspaceId: "workspace",
    cwd: "/repo/worktree",
    prompt: "Implement the change",
    model: "test-model",
    ...overrides,
  };
}

describe("additional harness adapters", () => {
  it("passes Codex conformance for every advertised capability", async () => {
    const runner = new HarnessRunner();
    const adapter = new CodexHarnessAdapter(new HerdrClient(runner));
    await assertAdapterConformance(adapter, {
      request: request(),
      requiredCapabilities: [
        "structured-events",
        "model-selection",
        "cancellation",
        "resume",
        "usage",
      ],
    });
    expect(adapter.capabilities.toolSelection).toBe(false);
    const invocation = await adapter.launch(request());
    expect((await adapter.collect(invocation)).usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      quality: "exact",
    });
    await expect(
      adapter.validate({ tools: ["read"] }, ["tool-selection"]),
    ).resolves.toMatchObject({ valid: false });
    expect(runner.calls.join("\n")).toContain("'codex' 'exec' '--json'");
    expect(runner.calls.join("\n")).toContain(
      "'codex' 'exec' 'resume' '--json'",
    );
    expect(runner.calls.join("\n")).toContain("'--sandbox' 'workspace-write'");
  });

  it("passes Claude conformance with structured resume, model, tools, and estimated usage", async () => {
    const runner = new HarnessRunner();
    const adapter = new ClaudeHarnessAdapter(new HerdrClient(runner));
    const launch = request({
      tools: ["Read", "Edit"],
      excludeTools: ["Bash(rm *)"],
    });
    await assertAdapterConformance(adapter, {
      request: launch,
      requiredCapabilities: [
        "structured-events",
        "model-selection",
        "tool-selection",
        "cancellation",
        "resume",
        "usage",
      ],
    });
    const invocation = await adapter.launch(launch);
    const result = await adapter.collect(invocation);
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      costUsd: 0.02,
      quality: "estimated",
    });
    expect(runner.calls.join("\n")).toContain(
      "'--output-format' 'stream-json'",
    );
    expect(runner.calls.join("\n")).toContain("'--allowedTools' 'Read' 'Edit'");
    expect(runner.calls.join("\n")).toContain(
      "'--disallowedTools' 'Bash(rm *)'",
    );
    expect(runner.calls.join("\n")).toContain(
      "'--resume' '550e8400-e29b-41d4-a716-446655440000'",
    );
  });

  it("passes Copilot conformance without claiming undocumented structured events or usage", async () => {
    const runner = new HarnessRunner();
    const adapter = new CopilotHarnessAdapter(new HerdrClient(runner));
    const launch = request({
      tools: ["write", "shell(git:*)"],
      excludeTools: ["shell(git push)"],
    });
    await assertAdapterConformance(adapter, {
      request: launch,
      requiredCapabilities: [
        "model-selection",
        "tool-selection",
        "cancellation",
        "resume",
      ],
    });
    expect(adapter.capabilities).toMatchObject({
      structuredEvents: false,
      usage: false,
      blockedInput: false,
    });
    const invocation = await adapter.launch(launch);
    expect((await adapter.collect(invocation)).usage).toEqual({
      quality: "unknown",
    });
    expect(runner.calls.join("\n")).toContain("'copilot' '--prompt'");
    expect(runner.calls.join("\n")).toContain("--allow-tool=write");
    expect(runner.calls.join("\n")).toContain("--deny-tool=shell(git push)");
    expect(runner.calls.join("\n")).toContain(
      "--resume=660e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("switches harness and model by phase across one sequential run", async () => {
    const runner = new HarnessRunner();
    const herdr = new HerdrClient(runner);
    const registry = new AdapterRegistry();
    registry.register(new CodexHarnessAdapter(herdr));
    registry.register(new ClaudeHarnessAdapter(herdr));
    registry.register(new CopilotHarnessAdapter(herdr));
    const workflow: Workflow = {
      schemaVersion: 1,
      id: "multi-harness",
      description: "Switch adapters by phase",
      phases: ["planning", "building", "reviewing"].map((id) => ({
        id,
        title: id,
        profile: id,
        guidelines: [],
        requiredCapabilities: ["model-selection"],
        work: [
          {
            id: `${id}-agent`,
            type: "agent" as const,
            profile: id,
            options: { prompt: `Execute ${id}` },
          },
        ],
        checks: [],
        gate: { mode: "automatic" as const },
      })),
      delivery: { mode: "local-branch", mergeMethod: "merge" },
    };
    const scheduler = new WorkflowScheduler(
      workflow,
      new HarnessWorkExecutor(registry, {
        runId: "8c86919c-3569-4e97-9f09-1bba7b49ed3d",
        workspaceId: "workspace",
        cwd: "/repo/worktree",
      }),
    );
    const selections = [
      { harness: "codex", model: "gpt-5-codex" },
      {
        harness: "claude",
        model: "claude-sonnet",
        tools: ["Read", "Edit"],
      },
      {
        harness: "copilot",
        model: "gpt-5.1-codex",
        tools: ["write"],
      },
    ];
    for (const [index, phase] of workflow.phases.entries()) {
      const result = await scheduler.executePhase(
        phase.id,
        { eligible: true, reasons: [] },
        { project: selections[index] },
      );
      expect(result.status).toBe("completed");
      expect(result.resolved).toMatchObject(selections[index]!);
    }
    const launches = runner.calls.filter((call) =>
      call.startsWith("herdr pane run"),
    );
    expect(launches.some((call) => call.includes("'codex' 'exec'"))).toBe(true);
    expect(launches.some((call) => call.includes("'claude' '--print'"))).toBe(
      true,
    );
    expect(launches.some((call) => call.includes("'copilot' '--prompt'"))).toBe(
      true,
    );
  });

  it("fails availability when an advertised integration or authentication is unavailable", async () => {
    class UnavailableRunner extends HarnessRunner {
      override async run(
        command: string,
        args: string[],
        options?: CommandOptions,
      ) {
        if (command === "claude" && args[0] === "auth")
          return { code: 0, stdout: '{"loggedIn":false}', stderr: "" };
        if (command === "herdr" && args[0] === "integration")
          return { code: 0, stdout: "", stderr: "" };
        return super.run(command, args, options);
      }
    }
    const result = await new ClaudeHarnessAdapter(
      new HerdrClient(new UnavailableRunner()),
    ).availability();
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Herdr integration is missing: claude"]);
  });
});
