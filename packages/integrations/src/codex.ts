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

export class CodexHarnessAdapter extends CliHarnessAdapter {
  readonly id = "codex";
  readonly executable = "codex";
  readonly capabilities: AdapterCapabilities = {
    structuredEvents: true,
    modelSelection: true,
    toolSelection: false,
    cancellation: true,
    blockedInput: false,
    resume: true,
    usage: true,
  };

  constructor(herdr: HerdrClient) {
    super(herdr);
  }

  protected override async authentication(): Promise<string | undefined> {
    const result = await this.herdr.runner.run(this.executable, [
      "login",
      "status",
    ]);
    return result.code === 0
      ? undefined
      : "Codex authentication is unavailable; run codex login";
  }

  protected launchCommand(request: AdapterLaunchRequest): string {
    const args = [
      this.executable,
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--config",
      'approval_policy="never"',
      "--cd",
      request.cwd,
    ];
    if (request.model) args.push("--model", request.model);
    args.push(request.prompt);
    return args.map(shellQuote).join(" ");
  }

  protected resumeCommand(
    invocation: AdapterInvocation,
    prompt: string,
  ): string {
    const args = [this.executable, "exec", "resume", "--json"];
    if (invocation.nativeSessionId) args.push(invocation.nativeSessionId);
    else args.push("--last");
    args.push(prompt);
    return args.map(shellQuote).join(" ");
  }

  protected usage(
    events: Array<Record<string, unknown>>,
  ): AdapterResult["usage"] {
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let totalTokens: number | undefined;
    for (const event of events) {
      const usage = nestedRecord(event.usage);
      if (!usage) continue;
      inputTokens =
        numeric(usage.input_tokens ?? usage.inputTokens) ?? inputTokens;
      outputTokens =
        numeric(usage.output_tokens ?? usage.outputTokens) ?? outputTokens;
      totalTokens =
        numeric(usage.total_tokens ?? usage.totalTokens) ?? totalTokens;
    }
    totalTokens ??=
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      quality: totalTokens === undefined ? "unknown" : "exact",
    };
  }
}
