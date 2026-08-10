import {
  type CommandRunner,
  type ProcessResult,
  NodeCommandRunner,
} from "./git.js";

export type HerdrAgentStatus =
  "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrIdentifiers {
  workspaceId?: string;
  worktreeId?: string;
  tabId?: string;
  paneId?: string;
  terminalId?: string;
  processId?: string;
}

export interface HerdrPaneObservation extends HerdrIdentifiers {
  status: HerdrAgentStatus;
  message?: string;
  raw: unknown;
}

export interface HerdrLaunch {
  workspaceId: string;
  cwd: string;
  label: string;
  command: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export interface HerdrDiagnostics {
  integrations: Array<{ name: string; installed: boolean }>;
  harnesses: Array<{ executable: string; available: boolean }>;
  ready: boolean;
}

export class HerdrCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ProcessResult,
  ) {
    super(
      `herdr ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
    this.name = "HerdrCommandError";
  }
}

export class HerdrProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrProtocolError";
  }
}

function normalizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function findValue(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findValue(nested, keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.includes(key) || keys.includes(normalizeKey(key))) {
      if (typeof nested === "string" || typeof nested === "number")
        return String(nested);
    }
  }
  for (const nested of Object.values(record)) {
    const found = findValue(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function parseResponse(result: ProcessResult): unknown {
  const output = result.stdout.trim();
  if (!output)
    throw new HerdrProtocolError("Herdr returned no machine-readable response");
  try {
    return JSON.parse(output) as unknown;
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(output.slice(start, end + 1)) as unknown;
      } catch {
        // Fall through to the protocol error below.
      }
    }
    throw new HerdrProtocolError(`Herdr returned non-JSON output: ${output}`);
  }
}

function identifiers(raw: unknown): HerdrIdentifiers {
  return {
    workspaceId: findValue(raw, ["workspace_id", "workspaceId"]),
    worktreeId: findValue(raw, ["worktree_id", "worktreeId"]),
    tabId: findValue(raw, ["tab_id", "tabId"]),
    paneId: findValue(raw, ["pane_id", "paneId"]),
    terminalId: findValue(raw, ["terminal_id", "terminalId"]),
    processId: findValue(raw, ["process_id", "processId", "pid"]),
  };
}

function agentStatus(raw: unknown): HerdrAgentStatus {
  const status = findValue(raw, ["agent_status", "agentStatus", "status"]);
  if (["idle", "working", "blocked", "done", "unknown"].includes(status ?? ""))
    return status as HerdrAgentStatus;
  return "unknown";
}

export class HerdrClient {
  constructor(
    readonly runner: CommandRunner = new NodeCommandRunner(),
    readonly executable = "herdr",
  ) {}

  private async execute(
    args: string[],
    timeoutMs?: number,
    allowEmpty = false,
  ): Promise<unknown> {
    const result = await this.runner.run(this.executable, args, { timeoutMs });
    if (result.code !== 0) throw new HerdrCommandError(args, result);
    if (allowEmpty && !result.stdout.trim()) return undefined;
    return parseResponse(result);
  }

  async createWorkspace(input: {
    cwd: string;
    label: string;
  }): Promise<HerdrIdentifiers> {
    const raw = await this.execute([
      "workspace",
      "create",
      "--cwd",
      input.cwd,
      "--label",
      input.label,
      "--no-focus",
    ]);
    const result = identifiers(raw);
    if (!result.workspaceId)
      throw new HerdrProtocolError(
        "Herdr workspace creation returned no workspace ID",
      );
    return result;
  }

  async openWorktree(input: {
    workspaceId: string;
    path: string;
    label: string;
  }): Promise<HerdrIdentifiers> {
    const raw = await this.execute([
      "worktree",
      "open",
      "--workspace",
      input.workspaceId,
      "--path",
      input.path,
      "--label",
      input.label,
      "--no-focus",
    ]);
    return {
      ...identifiers(raw),
      workspaceId: input.workspaceId,
      // Herdr versions that do not expose a worktree handle still have a
      // stable, SWF-owned path that can be recorded for safe cleanup.
      worktreeId: identifiers(raw).worktreeId ?? input.path,
    };
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
  }): Promise<HerdrIdentifiers> {
    const raw = await this.execute([
      "tab",
      "create",
      "--workspace",
      input.workspaceId,
      "--cwd",
      input.cwd,
      "--label",
      input.label,
      "--no-focus",
    ]);
    const result = { ...identifiers(raw), workspaceId: input.workspaceId };
    if (!result.tabId || !result.paneId)
      throw new HerdrProtocolError(
        "Herdr tab creation returned no tab or pane ID",
      );
    return result;
  }

  async observe(paneId: string): Promise<HerdrPaneObservation> {
    const raw = await this.execute(["pane", "get", paneId]);
    const result = identifiers(raw);
    return {
      ...result,
      paneId,
      status: agentStatus(raw),
      message: findValue(raw, ["message", "agent_message", "agentMessage"]),
      raw,
    };
  }

  async waitForReady(
    paneId: string,
    timeoutMs = 30_000,
  ): Promise<HerdrPaneObservation> {
    await this.execute(
      [
        "wait",
        "agent-status",
        paneId,
        "--status",
        "idle",
        "--timeout",
        String(timeoutMs),
      ],
      timeoutMs + 1_000,
    );
    return this.observe(paneId);
  }

  async launch(input: HerdrLaunch): Promise<HerdrPaneObservation> {
    const tab = await this.createTab(input);
    const environment = Object.entries(input.environment ?? {})
      .map(([key, value]) => `${key}='${value.replaceAll("'", `'"'"'`)}'`)
      .join(" ");
    const command = environment
      ? `env ${environment} ${input.command}`
      : input.command;
    await this.execute(
      ["pane", "run", tab.paneId!, command],
      input.timeoutMs,
      true,
    );
    const observation = await this.waitForReady(tab.paneId!, input.timeoutMs);
    return {
      ...tab,
      ...observation,
      tabId: observation.tabId ?? tab.tabId,
      terminalId: observation.terminalId ?? tab.terminalId,
      processId: observation.processId ?? tab.processId,
    };
  }

  async submitPrompt(paneId: string, prompt: string): Promise<void> {
    await this.execute(["pane", "run", paneId, prompt], undefined, true);
  }

  async transcript(paneId: string, lines = 200): Promise<string> {
    const result = await this.runner.run(this.executable, [
      "pane",
      "read",
      paneId,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
    ]);
    if (result.code !== 0)
      throw new HerdrCommandError(["pane", "read", paneId], result);
    return result.stdout;
  }

  async cancel(paneId: string): Promise<void> {
    await this.execute(
      ["pane", "send-keys", paneId, "ctrl-c"],
      undefined,
      true,
    );
  }

  async closePane(paneId: string): Promise<void> {
    await this.execute(["pane", "close", paneId], undefined, true);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.execute(["tab", "close", tabId], undefined, true);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.execute(["workspace", "close", workspaceId], undefined, true);
  }

  async removeWorktree(workspaceId: string): Promise<void> {
    await this.execute(
      ["worktree", "remove", "--workspace", workspaceId, "--force"],
      undefined,
      true,
    );
  }

  async reconcilePane(paneId: string): Promise<"missing" | HerdrAgentStatus> {
    try {
      return (await this.observe(paneId)).status;
    } catch (error) {
      if (error instanceof HerdrCommandError && error.result.code !== 0)
        return "missing";
      throw error;
    }
  }

  async diagnostics(
    requiredIntegrations: string[],
    requiredHarnesses: string[],
  ): Promise<HerdrDiagnostics> {
    const status = await this.runner.run(this.executable, [
      "integration",
      "status",
    ]);
    if (status.code !== 0)
      throw new HerdrCommandError(["integration", "status"], status);
    const integrations = requiredIntegrations.map((name) => ({
      name,
      installed: new RegExp(
        `^\\s*${name}:\\s*(?:installed|current)\\b`,
        "mi",
      ).test(status.stdout),
    }));
    const harnesses = await Promise.all(
      requiredHarnesses.map(async (executable) => ({
        executable,
        available: (await this.runner.run("which", [executable])).code === 0,
      })),
    );
    return {
      integrations,
      harnesses,
      ready:
        integrations.every((item) => item.installed) &&
        harnesses.every((item) => item.available),
    };
  }
}
