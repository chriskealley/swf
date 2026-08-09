import {
  type AdapterCapabilities,
  type AdapterInvocation,
  type AdapterLaunchRequest,
  type AdapterResult,
  type HerdrClient,
} from "@swf/core";
import { CliHarnessAdapter, shellQuote } from "./harness.js";

interface CopilotSessionOptions {
  model?: string;
  tools?: string[];
  excludeTools?: string[];
}

export class CopilotHarnessAdapter extends CliHarnessAdapter {
  readonly id = "copilot";
  readonly executable = "copilot";
  readonly capabilities: AdapterCapabilities = {
    structuredEvents: false,
    modelSelection: true,
    toolSelection: true,
    cancellation: true,
    blockedInput: false,
    resume: true,
    usage: false,
  };
  private readonly sessions = new Map<string, CopilotSessionOptions>();

  constructor(herdr: HerdrClient) {
    super(herdr);
  }

  private arguments(
    options: CopilotSessionOptions,
    prompt: string,
    sessionId?: string,
  ): string[] {
    const args = [
      this.executable,
      "--prompt",
      prompt,
      "--stream",
      "off",
      "--no-color",
    ];
    if (sessionId) args.push(`--resume=${sessionId}`);
    else if (sessionId === "") args.push("--continue");
    if (options.model) args.push("--model", options.model);
    if (options.tools?.length) {
      for (const tool of options.tools) args.push(`--allow-tool=${tool}`);
    } else args.push("--allow-all-tools");
    for (const tool of options.excludeTools ?? [])
      args.push(`--deny-tool=${tool}`);
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
    return this.arguments(
      this.sessions.get(invocation.invocationId) ?? {},
      prompt,
      invocation.nativeSessionId ?? "",
    )
      .map(shellQuote)
      .join(" ");
  }

  protected usage(): AdapterResult["usage"] {
    // Copilot exposes `/usage` interactively, but its documented programmatic
    // mode does not provide a stable machine-readable token/cost payload.
    return { quality: "unknown" };
  }
}
