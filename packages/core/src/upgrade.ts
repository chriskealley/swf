import { evaluateCompatibility, refusesWriterStartup } from "./product.js";
import type { ProductMetadata } from "./product.js";
import type { MigrationPlan } from "./operations.js";
import type { ManagedServiceDiagnostic } from "./managed-service.js";

export type UpgradeOutcome =
  | "current"
  | "restart-only"
  | "migration-required"
  | "incompatible"
  | "downgrade-refused";

export interface UpgradeStep {
  order: number;
  id: string;
  description: string;
  command?: string;
  /** True when the step can change state that is not trivially reversible. */
  mutating: boolean;
}

export interface UpgradeFinding {
  id:
    | "cli-version"
    | "service-version"
    | "api-protocol"
    | "state-schema"
    | "build-identity"
    | "managed-unit"
    | "project-config";
  status: "ok" | "changed" | "incompatible" | "unknown";
  detail: string;
}

export interface UpgradePreflight {
  outcome: UpgradeOutcome;
  /** True when mutations must not proceed until the operator acts. */
  blocked: boolean;
  findings: UpgradeFinding[];
  steps: UpgradeStep[];
  summary: string;
}

export interface UpgradePreflightInput {
  /** Metadata of the product the CLI was installed from. */
  installed: ProductMetadata;
  /** Health reported by the service currently running, if any. */
  runningService?: {
    productVersion?: string;
    sourceCommit?: string;
    apiProtocolVersion?: number;
    stateSchemaVersion?: number;
  };
  /** State schema version observed on disk for the project being inspected. */
  observedStateSchemaVersion?: number;
  migrationPlan?: MigrationPlan;
  managedService?: ManagedServiceDiagnostic[];
  /** Project configuration schema version, when a project is selected. */
  projectConfigVersion?: number;
}

function step(
  order: number,
  id: string,
  description: string,
  options: { command?: string; mutating?: boolean } = {},
): UpgradeStep {
  return {
    order,
    id,
    description,
    command: options.command,
    mutating: options.mutating ?? false,
  };
}

/**
 * Compares an installed product against the running service, persisted state,
 * and managed-service definition, and returns an ordered plan.
 *
 * Nothing is mutated. A package manager replacing product files does not
 * restart the service or migrate state, so the two can legitimately disagree
 * until an operator acts; this reports exactly what that action should be.
 */
export function evaluateUpgradePreflight(
  input: UpgradePreflightInput,
): UpgradePreflight {
  const findings: UpgradeFinding[] = [];
  const installedVersion = input.installed.build.productVersion;
  const compatibility = input.installed.compatibility;

  findings.push({
    id: "cli-version",
    status: "ok",
    detail: `installed product ${installedVersion} (${input.installed.build.channel})`,
  });

  const running = input.runningService;
  if (!running) {
    findings.push({
      id: "service-version",
      status: "unknown",
      detail: "no running service was detected",
    });
  } else {
    findings.push({
      id: "service-version",
      status: running.productVersion === installedVersion ? "ok" : "changed",
      detail:
        running.productVersion === installedVersion
          ? `service is running ${running.productVersion}`
          : `service is running ${running.productVersion ?? "unknown"}, installed product is ${installedVersion}`,
    });
    findings.push({
      id: "build-identity",
      status:
        running.sourceCommit === input.installed.build.sourceCommit
          ? "ok"
          : "changed",
      detail: `service build ${running.sourceCommit?.slice(0, 12) ?? "unknown"} vs installed ${input.installed.build.sourceCommit.slice(0, 12)}`,
    });

    const report = evaluateCompatibility(compatibility, {
      clientVersion: installedVersion,
      clientApiProtocolVersion: running.apiProtocolVersion,
      stateSchemaVersion: running.stateSchemaVersion,
    });
    const protocolFinding = report.findings.find(
      ({ id }) => id === "api-protocol",
    );
    findings.push({
      id: "api-protocol",
      status:
        protocolFinding?.status === "compatible"
          ? "ok"
          : protocolFinding?.status === "unknown"
            ? "unknown"
            : "incompatible",
      detail: protocolFinding?.detail ?? "API protocol was not reported",
    });
  }

  // A downgrade is the one case that must fail closed: an older product cannot
  // safely read state written by a newer one.
  const observed = input.observedStateSchemaVersion;
  const downgrade =
    observed !== undefined && refusesWriterStartup(compatibility, observed);
  if (observed !== undefined)
    findings.push({
      id: "state-schema",
      status: downgrade
        ? "incompatible"
        : observed === compatibility.stateSchemaVersion
          ? "ok"
          : "changed",
      detail: downgrade
        ? `state schema ${observed} is newer than the supported ${compatibility.stateSchemaVersion}`
        : `state schema ${observed}, product supports ${compatibility.stateSchemaVersion}`,
    });

  const migrationRequired = Boolean(input.migrationPlan?.migrations.length);
  if (input.migrationPlan)
    findings.push({
      id: "state-schema",
      status: migrationRequired ? "changed" : "ok",
      detail: migrationRequired
        ? `${input.migrationPlan.migrations.length} migration(s) from ${input.migrationPlan.from} to ${input.migrationPlan.to}`
        : "state is at the supported version",
    });

  const staleUnit = (input.managedService ?? []).filter(
    ({ id }) => id !== "healthy" && id !== "definition-missing",
  );
  if (input.managedService?.length)
    findings.push({
      id: "managed-unit",
      status: staleUnit.length ? "changed" : "ok",
      detail: staleUnit.length
        ? staleUnit.map(({ detail }) => detail).join("; ")
        : "managed service definition matches this product",
    });

  if (input.projectConfigVersion !== undefined)
    findings.push({
      id: "project-config",
      status: "ok",
      detail: `project configuration schema ${input.projectConfigVersion} is project-owned and is never rewritten by an upgrade`,
    });

  const incompatible = findings.some(
    ({ id, status }) => id === "api-protocol" && status === "incompatible",
  );
  const serviceChanged = findings.some(
    ({ id, status }) =>
      (id === "service-version" || id === "build-identity") &&
      status === "changed",
  );

  const outcome: UpgradeOutcome = downgrade
    ? "downgrade-refused"
    : migrationRequired
      ? "migration-required"
      : incompatible
        ? "incompatible"
        : serviceChanged
          ? "restart-only"
          : "current";

  return {
    outcome,
    blocked: outcome === "downgrade-refused" || outcome === "incompatible",
    findings,
    steps: upgradeSteps(outcome, {
      staleUnit: staleUnit.length > 0,
      migrationPlan: input.migrationPlan,
    }),
    summary: summarize(outcome),
  };
}

function summarize(outcome: UpgradeOutcome): string {
  switch (outcome) {
    case "current":
      return "The running service matches the installed product. No action is required.";
    case "restart-only":
      return "The installed product is newer than the running service. Restart the service to adopt it.";
    case "migration-required":
      return "State migration is required before the new product can write. Preview, back up, then apply.";
    case "incompatible":
      return "The installed CLI cannot safely mutate through the running service. Restart or upgrade before continuing.";
    case "downgrade-refused":
      return "Persisted state was written by a newer product. This product refuses to become the writer.";
  }
}

function upgradeSteps(
  outcome: UpgradeOutcome,
  context: { staleUnit: boolean; migrationPlan?: MigrationPlan },
): UpgradeStep[] {
  if (outcome === "current") return [];
  if (outcome === "downgrade-refused")
    return [
      step(
        1,
        "restore-or-upgrade",
        "Reinstall a product that supports the persisted state schema, or restore a compatible state backup.",
        { command: "swf migrate --rollback <backup-id>", mutating: true },
      ),
    ];

  const steps: UpgradeStep[] = [];
  let order = 1;
  if (outcome === "migration-required") {
    steps.push(
      step(order++, "preview-migration", "Review the ordered migration plan.", {
        command: "swf migrate",
      }),
      step(
        order++,
        "apply-migration",
        `Apply ${context.migrationPlan?.migrations.length ?? 0} migration(s); a checksummed backup is written first.`,
        { command: "swf migrate --apply", mutating: true },
      ),
    );
  }
  steps.push(
    step(
      order++,
      "drain-service",
      "Stop the running service, draining active work.",
      {
        command: "swf service stop",
        mutating: true,
      },
    ),
    step(
      order++,
      "start-service",
      "Start the service from the installed product.",
      {
        command: "swf service start",
        mutating: true,
      },
    ),
    step(order++, "verify-health", "Confirm the compatibility handshake.", {
      command: "swf service status",
    }),
  );
  if (context.staleUnit)
    steps.push(
      step(
        order,
        "repair-managed-service",
        "The managed service definition references stale paths. Preview a repair.",
        { command: "swf service install --repair", mutating: false },
      ),
    );
  return steps;
}

/** Human-readable, mutation-free preview. */
export function renderUpgradePreflight(preflight: UpgradePreflight): string {
  const lines = [preflight.summary, ""];
  for (const finding of preflight.findings)
    lines.push(`${finding.status.padEnd(12)} ${finding.id}: ${finding.detail}`);
  if (preflight.steps.length) {
    lines.push("", "Ordered plan (nothing has been changed):");
    for (const item of preflight.steps)
      lines.push(
        `  ${item.order}. ${item.description}${item.command ? `\n     ${item.command}` : ""}`,
      );
  }
  if (preflight.blocked)
    lines.push("", "Mutations are blocked until this is resolved.");
  return lines.join("\n");
}

export interface ServiceUpgradeResult {
  upgraded: boolean;
  drained: boolean;
  forced: boolean;
  reason?: string;
  /** Preserved on failure so an operator can diagnose without re-running. */
  diagnostics?: string[];
}

export interface ServiceUpgradeDependencies {
  hasActiveWork(): Promise<boolean>;
  stop(force: boolean): Promise<void>;
  validateNewEntry(): Promise<boolean>;
  start(): Promise<void>;
  verifyHealth(): Promise<{ ready: boolean; reason?: string }>;
  collectDiagnostics(): Promise<string[]>;
}

/**
 * Replaces a running service with the installed product. Active work is drained
 * unless the caller explicitly forces interruption, and the new entry is
 * validated before the old service is stopped so a failed upgrade cannot leave
 * an installation with neither.
 */
export async function performServiceUpgrade(
  dependencies: ServiceUpgradeDependencies,
  options: { force?: boolean } = {},
): Promise<ServiceUpgradeResult> {
  const force = options.force ?? false;

  if (!(await dependencies.validateNewEntry()))
    return {
      upgraded: false,
      drained: false,
      forced: force,
      reason:
        "the installed product has no valid service entry; the running service was left untouched",
    };

  const active = await dependencies.hasActiveWork();
  if (active && !force)
    return {
      upgraded: false,
      drained: false,
      forced: false,
      reason:
        "active work is in progress; wait for it to finish or re-run with --force to interrupt it",
    };

  await dependencies.stop(force);
  await dependencies.start();
  const health = await dependencies.verifyHealth();
  if (!health.ready)
    return {
      upgraded: false,
      drained: !active || force,
      forced: force,
      reason: health.reason ?? "the replacement service did not become healthy",
      diagnostics: await dependencies.collectDiagnostics(),
    };

  return { upgraded: true, drained: !active || force, forced: force };
}
