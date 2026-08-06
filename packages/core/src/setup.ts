import {
  requirements,
  requiredHerdrIntegrations,
  type Requirement,
  type RequirementId,
} from "./requirements.js";

export interface SetupAction {
  id: string;
  summary: string;
  source: string;
  version: string;
  destination: string;
  command: string;
  args: string[];
}

export interface SetupPlan {
  actions: SetupAction[];
  unsupported: string[];
}

export interface SetupExecution {
  execute(
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  confirm(action: SetupAction): Promise<boolean>;
}

function requirementVersion(id: RequirementId): string {
  return (
    (requirements[id] as Requirement).minimumVersion ?? "latest compatible"
  );
}

const npmPackages: Partial<Record<RequirementId, string>> = {
  pi: "@earendil-works/pi-coding-agent",
  openspec: "@fission-ai/openspec",
  codex: "@openai/codex",
  copilot: "@github/copilot",
};

export function createSetupPlan(
  targets: string[],
  platform: NodeJS.Platform = process.platform,
): SetupPlan {
  const actions: SetupAction[] = [];
  const unsupported: string[] = [];

  for (const target of targets) {
    if (target.startsWith("herdr-integration:")) {
      const integration = target.slice("herdr-integration:".length);
      if (
        !requiredHerdrIntegrations.includes(
          integration as (typeof requiredHerdrIntegrations)[number],
        )
      ) {
        unsupported.push(target);
        continue;
      }
      actions.push({
        id: target,
        summary: `Install the Herdr ${integration} integration`,
        source: "Herdr CLI",
        version: "compatible installed Herdr version",
        destination: "Herdr user configuration directory",
        command: "herdr",
        args: ["integration", "install", integration],
      });
      continue;
    }

    if (target === "herdr") {
      actions.push({
        id: target,
        summary: "Install Herdr from its official installer",
        source: "https://herdr.dev/install.sh",
        version: requirements.herdr.minimumVersion ?? "latest compatible",
        destination: "Herdr installer-managed PATH directory",
        command: "sh",
        args: ["-c", "curl -fsSL https://herdr.dev/install.sh | sh"],
      });
      continue;
    }

    const requirement = target as RequirementId;
    const npmPackage = npmPackages[requirement];
    if (npmPackage) {
      actions.push({
        id: target,
        summary: `Install ${npmPackage} globally using pnpm`,
        source: `npm:${npmPackage}`,
        version: requirementVersion(requirement),
        destination: "pnpm global bin directory",
        command: "pnpm",
        args: ["add", "--global", npmPackage],
      });
      continue;
    }

    if (target === "claude") {
      actions.push({
        id: target,
        summary: "Install Claude Code globally using pnpm",
        source: "npm:@anthropic-ai/claude-code",
        version: "latest compatible",
        destination: "pnpm global bin directory",
        command: "pnpm",
        args: ["add", "--global", "@anthropic-ai/claude-code"],
      });
      continue;
    }

    const brewPackages: Partial<Record<string, string>> = {
      node: "node@22",
      git: "git",
      gh: "gh",
    };
    const aptPackages: Partial<Record<string, string>> = {
      node: "nodejs",
      git: "git",
      gh: "gh",
    };
    const packageName =
      platform === "darwin"
        ? brewPackages[target]
        : platform === "linux"
          ? aptPackages[target]
          : undefined;
    if (packageName) {
      const isBrew = platform === "darwin";
      actions.push({
        id: target,
        summary: `Install ${target} using ${isBrew ? "Homebrew" : "APT"}`,
        source: isBrew ? "Homebrew" : "APT package repository",
        version: requirementVersion(requirement),
        destination: isBrew
          ? "Homebrew-managed PATH directory"
          : "system package directory",
        command: isBrew ? "brew" : "sudo",
        args: isBrew
          ? ["install", packageName]
          : ["apt-get", "install", "-y", packageName],
      });
      continue;
    }

    unsupported.push(target);
  }

  return { actions, unsupported };
}

export async function applySetupPlan(
  plan: SetupPlan,
  execution: SetupExecution,
) {
  const results: Array<{
    action: SetupAction;
    applied: boolean;
    code?: number;
    stderr?: string;
  }> = [];
  for (const action of plan.actions) {
    if (!(await execution.confirm(action))) {
      results.push({ action, applied: false });
      continue;
    }
    const result = await execution.execute(action.command, action.args);
    results.push({
      action,
      applied: result.code === 0,
      code: result.code,
      stderr: result.stderr,
    });
  }
  return { results, unsupported: plan.unsupported };
}
