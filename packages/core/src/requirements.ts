export interface Requirement {
  command: string;
  minimumVersion?: string;
  required: boolean;
  reason: string;
}

export const requirements = {
  node: {
    command: "node",
    minimumVersion: "22.19.0",
    required: true,
    reason:
      "SWF, Pi, and the selected TypeScript runtime require Node.js >=22.19.0.",
  },
  git: {
    command: "git",
    minimumVersion: "2.30.0",
    required: true,
    reason: "SWF requires Git branches, worktrees, checkpoints, and rollback.",
  },
  herdr: {
    command: "herdr",
    minimumVersion: "0.7.4",
    required: true,
    reason: "Herdr is SWF's terminal and process execution substrate.",
  },
  pi: {
    command: "pi",
    minimumVersion: "0.83.0",
    required: true,
    reason: "Pi is the reference harness and hosts the SWF extension.",
  },
  openspec: {
    command: "openspec",
    minimumVersion: "1.6.0",
    required: true,
    reason: "OpenSpec owns software-change planning artifacts.",
  },
  gh: {
    command: "gh",
    minimumVersion: "2.0.0",
    required: true,
    reason:
      "GitHub CLI supplies required authentication and PR delivery operations.",
  },
  codex: {
    command: "codex",
    required: false,
    reason: "Codex CLI is an optional harness unless selected by a workflow.",
  },
  claude: {
    command: "claude",
    required: false,
    reason: "Claude Code is an optional harness unless selected by a workflow.",
  },
  copilot: {
    command: "copilot",
    required: false,
    reason:
      "GitHub Copilot CLI is an optional harness unless selected by a workflow.",
  },
} as const satisfies Record<string, Requirement>;

export type RequirementId = keyof typeof requirements;

export const requiredHerdrIntegrations = ["pi"] as const;
export type HerdrIntegration = (typeof requiredHerdrIntegrations)[number];

export const supportedPlatforms = ["darwin", "linux"] as const;
