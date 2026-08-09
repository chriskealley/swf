import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  requiredHerdrIntegrations,
  requirements,
  supportedPlatforms,
  type Requirement,
  type RequirementId,
} from "./requirements.js";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  detail?: string;
  remediation?: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface DoctorOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  execute?: (command: string, args: string[], cwd: string) => CommandResult;
  selectedHarnesses?: RequirementId[];
}

function defaultExecute(
  command: string,
  args: string[],
  cwd: string,
): CommandResult {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function versionFrom(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
}

function compareVersions(actual: string, minimum: string): number {
  const normalize = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [actualParts, minimumParts] = [normalize(actual), normalize(minimum)];
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function commandOnPath(
  command: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const path = environment.PATH ?? "";
  return path
    .split(delimiter)
    .some((directory) => existsSync(join(directory, command)));
}

function executableCheck(
  id: RequirementId,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  execute: DoctorOptions["execute"],
): DoctorCheck {
  const requirement: Requirement = requirements[id];
  if (!commandOnPath(requirement.command, environment)) {
    return {
      id: `tool.${id}`,
      status: requirement.required ? "fail" : "warn",
      summary: `${requirement.command} is not available on PATH`,
      detail: requirement.reason,
      remediation: `Run swf setup --install ${id} after reviewing the proposed command.`,
    };
  }

  const result = (execute ?? defaultExecute)(
    requirement.command,
    ["--version"],
    cwd,
  );
  const actualVersion = versionFrom(`${result.stdout}\n${result.stderr}`);
  if (result.status !== 0 || !actualVersion) {
    return {
      id: `tool.${id}`,
      status: requirement.required ? "fail" : "warn",
      summary: `${requirement.command} could not report a version`,
      detail: requirement.reason,
    };
  }

  if (
    requirement.minimumVersion &&
    compareVersions(actualVersion, requirement.minimumVersion) < 0
  ) {
    return {
      id: `tool.${id}`,
      status: "fail",
      summary: `${requirement.command} ${actualVersion} is below required ${requirement.minimumVersion}`,
      detail: requirement.reason,
      remediation: `Run swf setup --install ${id} after reviewing the proposed command.`,
    };
  }

  return {
    id: `tool.${id}`,
    status: "pass",
    summary: `${requirement.command} ${actualVersion}`,
    detail: requirement.reason,
  };
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const execute = options.execute ?? defaultExecute;
  const checks: DoctorCheck[] = [];

  checks.push({
    id: "platform",
    status: supportedPlatforms.includes(
      platform as (typeof supportedPlatforms)[number],
    )
      ? "pass"
      : "warn",
    summary: `${platform}/${architecture}`,
    detail: supportedPlatforms.includes(
      platform as (typeof supportedPlatforms)[number],
    )
      ? "macOS and Linux are supported."
      : "Native Windows is preview-only while Herdr Windows support is preview.",
  });

  const toolIds: RequirementId[] = [
    "node",
    "git",
    "herdr",
    "pi",
    "openspec",
    "gh",
  ];
  for (const harness of options.selectedHarnesses ?? []) {
    if (!toolIds.includes(harness)) toolIds.push(harness);
  }
  for (const toolId of toolIds)
    checks.push(executableCheck(toolId, cwd, environment, execute));

  checks.push({
    id: "terminal",
    status: process.stdout.isTTY && environment.TERM ? "pass" : "skip",
    summary:
      process.stdout.isTTY && environment.TERM
        ? `interactive terminal: ${environment.TERM}`
        : "no interactive terminal detected",
    detail:
      "Ghostty is optional; interactive Pi and Herdr need UTF-8 and ANSI terminal capabilities.",
  });

  try {
    await access(cwd);
    checks.push({
      id: "project.write-access",
      status: "pass",
      summary: `project directory is accessible: ${cwd}`,
    });
  } catch {
    checks.push({
      id: "project.write-access",
      status: "fail",
      summary: `project directory is inaccessible: ${cwd}`,
    });
  }

  const gitResult = execute("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (gitResult.status === 0 && gitResult.stdout.trim() === "true") {
    checks.push({
      id: "git.repository",
      status: "pass",
      summary: "Git worktree detected",
    });
    const remote = execute("git", ["remote", "get-url", "origin"], cwd);
    checks.push(
      remote.status === 0
        ? {
            id: "git.remote",
            status: "pass",
            summary: `origin: ${remote.stdout.trim()}`,
          }
        : {
            id: "git.remote",
            status: "warn",
            summary: "origin remote is not configured",
            remediation:
              "Configure a GitHub remote before a pull-request delivery workflow.",
          },
    );
  } else {
    checks.push({
      id: "git.repository",
      status: "warn",
      summary: "not inside a Git worktree",
    });
  }

  const ghAuth = execute("gh", ["auth", "status"], cwd);
  checks.push(
    ghAuth.status === 0
      ? {
          id: "github.authentication",
          status: "pass",
          summary: "GitHub CLI authentication is available",
        }
      : {
          id: "github.authentication",
          status: "fail",
          summary: "GitHub CLI authentication is unavailable",
          remediation: "Run gh auth login, then rerun swf doctor.",
        },
  );

  const herdrStatus = execute("herdr", ["integration", "status"], cwd);
  const harnessIntegrations = [
    ...requiredHerdrIntegrations,
    ...(options.selectedHarnesses ?? []).filter((harness) =>
      ["codex", "claude", "copilot"].includes(harness),
    ),
  ];
  for (const integration of new Set(harnessIntegrations)) {
    const installed = new RegExp(`^${integration}: installed`, "m").test(
      herdrStatus.stdout,
    );
    checks.push(
      installed
        ? {
            id: `herdr.integration.${integration}`,
            status: "pass",
            summary: `${integration} integration installed`,
          }
        : {
            id: `herdr.integration.${integration}`,
            status: "warn",
            summary: `${integration} integration is not installed`,
            remediation: `Run swf setup --install herdr-integration:${integration}.`,
          },
    );
  }

  return checks;
}
