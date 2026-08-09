import {
  type AdapterCapabilities,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterResult,
  type HerdrClient,
} from "@swf/core";
import {
  CliHarnessAdapter,
  nestedRecord,
  numeric,
  shellQuote,
} from "./harness.js";

interface ClaudeSessionOptions {
  model?: string;
  tools?: string[];
  excludeTools?: string[];
}

export class ClaudeHarnessAdapter extends CliHarnessAdapter {
  readonly id = "claude";
  readonly executable = "claude";
  readonly capabilities: AdapterCapabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: false,
    resume: true,
    usage: true,
  };
  private readonly sessions = new Map<string, ClaudeSessionOptions>();

  constructor(herdr: HerdrClient) {
    super(herdr);
  }

  protected override async authentication(): Promise<string | undefined> {
    const result = await this.herdr.runner.run(this.executable, [
      "auth",
      "status",
      "--json",
    ]);
    if (result.code !== 0)
      return "Claude authentication is unavailable; run claude auth login";
    try {
      const status = JSON.parse(result.stdout) as { loggedIn?: boolean };
      return status.loggedIn
        ? undefined
        : "Claude authentication is unavailable; run claude auth login or configure ANTHROPIC_API_KEY";
    } catch {
      return "Claude authentication status was not valid JSON";
    }
  }

  private arguments(
    options: ClaudeSessionOptions,
    prompt: string,
    sessionId?: string,
  ): string[] {
    const args = [
      this.executable,
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (options.model) args.push("--model", options.model);
    const tools = options.tools?.length
      ? options.tools
      : ["Read", "Edit", "Write", "Bash"];
    args.push("--tools", tools.join(","));
    args.push("--allowedTools", ...tools);
    if (options.excludeTools?.length)
      args.push("--disallowedTools", ...options.excludeTools);
    args.push(prompt);
    return args;
  }

  protected launchCommand(request: AdapterLaunchRequest): string {
    return this.arguments(request, request.prompt).map(shellQuote).join(" ");
  }

  override async launch(
    request: AdapterLaunchRequest,
  ): Promise<AdapterInvocation> {
    const invocation = await super.launch(request);
    this.sessions.set(invocation.invocationId, {
      model: request.model,
      tools: request.tools,
      excludeTools: request.excludeTools,
    });
    return invocation;
  }

  protected resumeCommand(
    invocation: AdapterInvocation,
    prompt: string,
  ): string {
    const options = this.sessions.get(invocation.invocationId) ?? {};
    const args = this.arguments(options, prompt, invocation.nativeSessionId);
    if (!invocation.nativeSessionId) {
      const promptIndex = args.length - 1;
      args.splice(promptIndex, 0, "--continue");
    }
    return args.map(shellQuote).join(" ");
  }

  protected usage(
    events: Array<Record<string, unknown>>,
  ): AdapterResult["usage"] {
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let costUsd: number | undefined;
    for (const event of events) {
      const usage = nestedRecord(event.usage);
      if (usage) {
        inputTokens =
          numeric(usage.input_tokens ?? usage.inputTokens) ?? inputTokens;
        outputTokens =
          numeric(usage.output_tokens ?? usage.outputTokens) ?? outputTokens;
      }
      costUsd =
        numeric(event.total_cost_usd ?? event.cost_usd ?? event.costUsd) ??
        costUsd;
      const modelUsage = nestedRecord(event.modelUsage ?? event.model_usage);
      if (modelUsage) {
        const totals = Object.values(modelUsage)
          .map(nestedRecord)
          .filter(
            (value): value is Record<string, unknown> => value !== undefined,
          )
          .reduce<{ input: number; output: number }>(
            (sum, value) => ({
              input:
                sum.input +
                (numeric(value.inputTokens ?? value.input_tokens) ?? 0),
              output:
                sum.output +
                (numeric(value.outputTokens ?? value.output_tokens) ?? 0),
            }),
            { input: 0, output: 0 },
          );
        if (totals.input || totals.output) {
          inputTokens = totals.input;
          outputTokens = totals.output;
        }
      }
    }
    const totalTokens =
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      quality:
        totalTokens === undefined && costUsd === undefined
          ? "unknown"
          : "estimated",
    };
  }
}
