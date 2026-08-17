import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServiceLaunchPlan } from "./service-launcher.js";

export type ManagedServicePlatform = "launchd" | "systemd" | "unsupported";

/** Reverse-DNS label on macOS; unit name on Linux. Both must be stable. */
export const MANAGED_SERVICE_LABEL = "dev.swf.service";
export const SYSTEMD_UNIT_NAME = "swf.service";

export function detectManagedServicePlatform(
  platform: NodeJS.Platform = process.platform,
): ManagedServicePlatform {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "unsupported";
}

export interface ManagedServicePaths {
  definitionPath: string;
  standardOutputPath: string;
  standardErrorPath: string;
}

export function managedServicePaths(
  platform: ManagedServicePlatform,
  serviceHome: string,
  home = homedir(),
): ManagedServicePaths {
  const standardOutputPath = join(serviceHome, "logs", "managed-service.log");
  const standardErrorPath = join(
    serviceHome,
    "logs",
    "managed-service.error.log",
  );
  if (platform === "launchd")
    return {
      definitionPath: join(
        home,
        "Library",
        "LaunchAgents",
        `${MANAGED_SERVICE_LABEL}.plist`,
      ),
      standardOutputPath,
      standardErrorPath,
    };
  return {
    definitionPath: join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME),
    standardOutputPath,
    standardErrorPath,
  };
}

export interface ManagedServicePlan {
  platform: ManagedServicePlatform;
  label: string;
  definitionPath: string;
  executable: string;
  args: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  standardOutputPath: string;
  standardErrorPath: string;
  /** Commands the user must confirm before anything is applied. */
  enableCommands: string[][];
  disableCommands: string[][];
  /** True only when the user explicitly asks for start-at-login behaviour. */
  runAtLoad: boolean;
  definition: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderLaunchAgent(
  plan: Omit<ManagedServicePlan, "definition">,
): string {
  const stringEntries = [plan.executable, ...plan.args]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");
  const environmentEntries = Object.entries(plan.environment)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(plan.label)}</string>
    <key>ProgramArguments</key>
    <array>
${stringEntries}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>
    <key>WorkingDirectory</key>
    <string>${escapeXml(plan.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(plan.standardOutputPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(plan.standardErrorPath)}</string>
    <key>RunAtLoad</key>
    <${plan.runAtLoad ? "true" : "false"}/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`;
}

function renderSystemdUnit(
  plan: Omit<ManagedServicePlan, "definition">,
): string {
  const environment = Object.entries(plan.environment)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n");
  const command = [plan.executable, ...plan.args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
  return `[Unit]
# managed-by: ${MANAGED_SERVICE_LABEL}
Description=SWF durable agentic software factory service
Documentation=https://github.com/chriskealley/swf
After=default.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${plan.workingDirectory}
${environment}
StandardOutput=append:${plan.standardOutputPath}
StandardError=append:${plan.standardErrorPath}
Restart=no

[Install]
WantedBy=default.target
`;
}

export interface ManagedServicePlanInput {
  launch: ServiceLaunchPlan;
  platform?: ManagedServicePlatform;
  home?: string;
  /** Start automatically at login. Off unless explicitly requested. */
  runAtLoad?: boolean;
}

export class UnsupportedManagedServiceError extends Error {
  constructor(readonly platform: NodeJS.Platform) {
    super(
      [
        `Managed user services are not supported on ${platform}.`,
        "Run the service in the foreground with `swf service start`, which",
        "detaches and writes private logs, and stop it with `swf service stop`.",
      ].join(" "),
    );
    this.name = "UnsupportedManagedServiceError";
  }
}

/**
 * Builds a preview of the managed-service definition. Nothing is written: the
 * plan exists so a user can read every path, argument, and action before
 * anything touches their machine.
 */
export function createManagedServicePlan(
  input: ManagedServicePlanInput,
): ManagedServicePlan {
  const platform = input.platform ?? detectManagedServicePlatform();
  if (platform === "unsupported")
    throw new UnsupportedManagedServiceError(process.platform);

  const paths = managedServicePaths(
    platform,
    input.launch.serviceHome,
    input.home,
  );
  const base: Omit<ManagedServicePlan, "definition"> = {
    platform,
    label: platform === "launchd" ? MANAGED_SERVICE_LABEL : SYSTEMD_UNIT_NAME,
    definitionPath: paths.definitionPath,
    executable: input.launch.executable,
    args: input.launch.args,
    environment: input.launch.environment,
    workingDirectory: input.launch.cwd,
    standardOutputPath: paths.standardOutputPath,
    standardErrorPath: paths.standardErrorPath,
    runAtLoad: input.runAtLoad ?? false,
    enableCommands:
      platform === "launchd"
        ? [
            [
              "launchctl",
              "bootstrap",
              `gui/${process.getuid?.() ?? 0}`,
              paths.definitionPath,
            ],
          ]
        : [
            ["systemctl", "--user", "daemon-reload"],
            ["systemctl", "--user", "enable", SYSTEMD_UNIT_NAME],
          ],
    disableCommands:
      platform === "launchd"
        ? [
            [
              "launchctl",
              "bootout",
              `gui/${process.getuid?.() ?? 0}/${MANAGED_SERVICE_LABEL}`,
            ],
          ]
        : [
            ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME],
            ["systemctl", "--user", "daemon-reload"],
          ],
  };
  return {
    ...base,
    definition:
      platform === "launchd"
        ? renderLaunchAgent(base)
        : renderSystemdUnit(base),
  };
}

/** Human-readable preview. Shows every effect before confirmation. */
export function renderManagedServicePlan(plan: ManagedServicePlan): string {
  const lines = [
    `platform     ${plan.platform}`,
    `label        ${plan.label}`,
    `destination  ${plan.definitionPath}`,
    `executable   ${plan.executable}`,
    `arguments    ${plan.args.join(" ")}`,
    `working dir  ${plan.workingDirectory}`,
    `stdout       ${plan.standardOutputPath}`,
    `stderr       ${plan.standardErrorPath}`,
    `start at login ${plan.runAtLoad ? "yes" : "no"}`,
    "environment",
    ...Object.entries(plan.environment).map(
      ([key, value]) => `  ${key}=${value}`,
    ),
    "commands run only after confirmation",
    ...plan.enableCommands.map((command) => `  ${command.join(" ")}`),
  ];
  return lines.join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ApplyResult {
  written: boolean;
  definitionPath: string;
  /** Commands the caller must run; never executed implicitly. */
  pendingCommands: string[][];
}

/**
 * Writes the definition after explicit confirmation. Enablement and startup are
 * deliberately left to the caller so installing a package can never register or
 * launch a background service.
 */
export async function applyManagedServicePlan(
  plan: ManagedServicePlan,
  options: { confirmed: boolean } = { confirmed: false },
): Promise<ApplyResult> {
  if (!options.confirmed)
    throw new Error(
      "Refusing to install a managed service without explicit confirmation",
    );
  await mkdir(dirname(plan.definitionPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plan.standardOutputPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(plan.definitionPath, plan.definition, { mode: 0o600 });
  return {
    written: true,
    definitionPath: plan.definitionPath,
    pendingCommands: plan.enableCommands,
  };
}

export interface ManagedServiceDiagnostic {
  id:
    | "definition-missing"
    | "not-owned"
    | "stale-node"
    | "stale-package"
    | "stale-working-directory"
    | "environment-drift"
    | "healthy";
  detail: string;
  remediation?: string;
}

/**
 * Compares an installed definition against the current product. Node version
 * managers relocate their binaries and package upgrades move product paths, so
 * a definition that silently references a missing executable would fail at
 * login with no explanation.
 */
export async function diagnoseManagedService(
  plan: ManagedServicePlan,
): Promise<ManagedServiceDiagnostic[]> {
  if (!(await exists(plan.definitionPath)))
    return [
      {
        id: "definition-missing",
        detail: `no managed service definition at ${plan.definitionPath}`,
        remediation: "Run swf service install to preview one.",
      },
    ];

  const installed = await readFile(plan.definitionPath, "utf8");
  if (!installed.includes(MANAGED_SERVICE_LABEL))
    return [
      {
        id: "not-owned",
        detail: `${plan.definitionPath} is not an SWF-owned definition`,
        remediation:
          "Remove it manually; SWF will not modify definitions it does not own.",
      },
    ];

  const findings: ManagedServiceDiagnostic[] = [];

  // Check the paths this plan would use rather than scraping them from the
  // rendered file: definitions quote paths containing spaces, so any regex
  // extraction would truncate them and report false staleness.
  if (!(await exists(plan.executable)))
    findings.push({
      id: "stale-node",
      detail: `configured Node executable is missing: ${plan.executable}`,
      remediation:
        "A Node version manager likely moved it. Run swf service install --repair.",
    });

  const entryPath = plan.args[0];
  if (entryPath && !(await exists(entryPath)))
    findings.push({
      id: "stale-package",
      detail: `configured service entry is missing: ${entryPath}`,
      remediation:
        "The product was moved or reinstalled. Run swf service install --repair.",
    });

  if (!(await exists(plan.workingDirectory)))
    findings.push({
      id: "stale-working-directory",
      detail: `working directory is missing: ${plan.workingDirectory}`,
      remediation: "Run swf service install --repair.",
    });

  if (!installed.includes(plan.environment.SWF_SERVICE_HOME ?? ""))
    findings.push({
      id: "environment-drift",
      detail: "installed definition references a different service home",
      remediation: "Run swf service install --repair to rewrite it.",
    });

  return findings.length
    ? findings
    : [{ id: "healthy", detail: "installed definition matches this product" }];
}

export interface RepairPreview {
  required: boolean;
  findings: ManagedServiceDiagnostic[];
  definitionPath: string;
  /** The definition that would replace the installed one. */
  replacement: string;
}

export async function previewManagedServiceRepair(
  plan: ManagedServicePlan,
): Promise<RepairPreview> {
  const findings = await diagnoseManagedService(plan);
  return {
    required: findings.some(({ id }) => id !== "healthy" && id !== "not-owned"),
    findings,
    definitionPath: plan.definitionPath,
    replacement: plan.definition,
  };
}

export interface UninstallResult {
  removed: boolean;
  definitionPath: string;
  pendingCommands: string[][];
  preservedPaths: string[];
}

/**
 * Removes only the SWF-owned definition. Operational state is never touched:
 * service uninstall is not state uninstall.
 */
export async function uninstallManagedService(
  plan: ManagedServicePlan,
  options: { confirmed: boolean } = { confirmed: false },
): Promise<UninstallResult> {
  if (!options.confirmed)
    throw new Error(
      "Refusing to remove a managed service without explicit confirmation",
    );
  const preservedPaths = [
    plan.environment.SWF_SERVICE_HOME ?? "",
    plan.standardOutputPath,
    plan.standardErrorPath,
  ].filter(Boolean);

  if (!(await exists(plan.definitionPath)))
    return {
      removed: false,
      definitionPath: plan.definitionPath,
      pendingCommands: [],
      preservedPaths,
    };

  const installed = await readFile(plan.definitionPath, "utf8");
  if (!installed.includes(MANAGED_SERVICE_LABEL))
    throw new Error(
      `Refusing to remove ${plan.definitionPath}: it is not an SWF-owned definition`,
    );

  await rm(plan.definitionPath, { force: true });
  return {
    removed: true,
    definitionPath: plan.definitionPath,
    pendingCommands: plan.disableCommands,
    preservedPaths,
  };
}

export interface OrphanedServiceReport {
  orphaned: boolean;
  definitionPath: string;
  detail: string;
  /** Both options are offered; neither is performed. */
  options: Array<{ action: string; command: string; effect: string }>;
}

/**
 * Detects a managed service definition left behind after the product was
 * removed. A package manager cannot run reliable removal hooks, so the
 * definition survives and would fail at login with no explanation. State is
 * never touched: this only reports and offers choices.
 */
export async function diagnoseOrphanedManagedService(
  definitionPath: string,
  serviceEntryPath: string | undefined,
): Promise<OrphanedServiceReport> {
  const hasDefinition = await exists(definitionPath);
  if (!hasDefinition)
    return {
      orphaned: false,
      definitionPath,
      detail: "no managed service definition is installed",
      options: [],
    };

  const installed = await readFile(definitionPath, "utf8").catch(() => "");
  if (!installed.includes(MANAGED_SERVICE_LABEL))
    return {
      orphaned: false,
      definitionPath,
      detail: "a definition exists at this path but SWF does not own it",
      options: [],
    };

  const productPresent =
    serviceEntryPath !== undefined && (await exists(serviceEntryPath));
  if (productPresent)
    return {
      orphaned: false,
      definitionPath,
      detail: "the managed service definition matches an installed product",
      options: [],
    };

  return {
    orphaned: true,
    definitionPath,
    detail: `the managed service definition remains but its product is gone (${serviceEntryPath ?? "no entry path recorded"})`,
    options: [
      {
        action: "reinstall the product",
        command: "npm install --global @chriskealley/swf",
        effect:
          "restores the product the definition points at; no state is changed",
      },
      {
        action: "remove the definition",
        command: "swf service uninstall --apply --yes",
        effect:
          "removes only the definition; service home, credentials, and all project state are preserved",
      },
    ],
  };
}

/** Guidance where managed services are unavailable. */
export function manualFallbackGuidance(): string[] {
  return [
    "Managed user services are supported on macOS (launchd) and Linux (systemd).",
    "Elsewhere, run `swf service start`, which detaches the service and writes",
    "private rotating logs, and `swf service stop` to end it.",
    "Inspect recent output with `swf service logs`.",
  ];
}

export async function definitionPermissions(
  definitionPath: string,
): Promise<number | undefined> {
  const stats = await stat(definitionPath).catch(() => undefined);
  return stats ? stats.mode & 0o777 : undefined;
}
