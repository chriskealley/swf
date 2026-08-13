import type {
  ClassifiedOperatorError,
  OperatorAction,
  OperatorProjection,
} from "@swf/core";

export interface RenderOptions {
  verbose?: boolean;
}

function quote(value: string): string {
  return /^[a-zA-Z0-9._/-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderActionCommand(action: OperatorAction): string {
  const p = action.parameters;
  const change = quote(p.changeName);
  switch (action.type) {
    case "run-phase":
      return `swf next ${change}`;
    case "continue-run":
    case "retry":
    case "resume":
      return `swf run ${change}`;
    case "approve":
    case "request-changes":
    case "reject":
      return `swf ${action.type} ${change}`;
    case "reply-to-invocation":
      return `swf input ${change} <response>`;
    case "inspect-evidence":
      return `swf artifacts ${change}`;
    case "review-delivery":
      return p.branch
        ? `git diff ${quote(p.targetBranch ?? "main")}...${quote(p.branch)}`
        : `swf delivery status --project ${p.projectId} --run ${p.runId}`;
    case "merge-delivery":
      return p.branch
        ? `git merge ${quote(p.branch)}`
        : `swf delivery start --project ${p.projectId} --run ${p.runId}`;
    case "configure":
      return "swf config";
    case "reconcile":
      return `swf reconcile --project ${p.projectId}`;
  }
}

function renderActions(projection: OperatorProjection): string[] {
  if (!projection.allowedActions.length) return [];
  return [
    "Next actions:",
    ...projection.allowedActions.map(
      (action) =>
        `  ${action.recommended ? "→" : " "} ${action.label}: ${renderActionCommand(action)}`,
    ),
  ];
}

export function renderOperatorProjection(
  projection: OperatorProjection,
  options: RenderOptions = {},
): string {
  const lines = [projection.summary];
  const approval = projection.attention.find(
    ({ type }) => type === "manual-approval",
  );
  if (approval) {
    lines.push(
      "",
      `Approval required: ${approval.phaseId ?? "workflow"}`,
      `Reason: ${approval.reason}`,
    );
    if (approval.evidence?.checks.length)
      lines.push(
        `Checks: ${approval.evidence.checks.map(({ id, status }) => `${id} ${status}`).join(", ")}`,
      );
    if (approval.evidence?.changedPaths.length)
      lines.push(`Changed paths: ${approval.evidence.changedPaths.join(", ")}`);
    if (approval.evidence?.risks.length)
      lines.push(`Handoff risks: ${approval.evidence.risks.join("; ")}`);
    if (approval.evidence?.artifactIds.length)
      lines.push(`Evidence: ${approval.evidence.artifactIds.length} retained artifact(s)`);
  } else if (projection.status === "paused" && projection.completedPhaseId) {
    lines.push(
      "",
      `Completed phase: ${projection.completedPhaseId}`,
      `Checkpoints: ${projection.delivery?.checkpointCount ?? "recorded"}`,
    );
    if (projection.nextPhaseId) lines.push(`Next phase: ${projection.nextPhaseId}`);
  } else if (projection.status === "completed" && projection.delivery) {
    lines.push(
      "",
      `Delivery: ${projection.delivery.status}`,
      `Branch: ${projection.delivery.branch} → ${projection.delivery.targetBranch}`,
      `Checkpoints: ${projection.delivery.checkpointCount}`,
    );
    if (projection.delivery.dossierRef)
      lines.push(`Dossier: ${projection.delivery.dossierRef}`);
  } else if (projection.attention.length) {
    lines.push(
      "",
      ...projection.attention.map(
        ({ title, reason, retryable }) =>
          `${title}: ${reason}${retryable ? " (retryable)" : ""}`,
      ),
    );
  }
  lines.push("", ...renderActions(projection));
  if (options.verbose)
    lines.push(
      "",
      `Project: ${projection.projectId}`,
      `Run: ${projection.runId}`,
      `Stopping phase: ${projection.stoppingPhaseId ?? "none"}`,
      `Artifacts: ${projection.evidence.artifactIds.join(", ") || "none"}`,
    );
  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
}

export function renderOperatorError(
  error: ClassifiedOperatorError,
  projection?: OperatorProjection,
  options: RenderOptions = {},
): string {
  const lines = [
    `${error.category} failure: ${error.message}`,
    error.runStatus ? `Run remains ${error.runStatus}.` : "",
    error.retryable ? "This failure is safe to retry." : "Review the guidance before retrying.",
  ].filter(Boolean);
  if (projection) lines.push("", renderOperatorProjection(projection, options));
  if (options.verbose && error.diagnosticRefs.length)
    lines.push("", `Diagnostics: ${error.diagnosticRefs.join(", ")}`);
  return lines.join("\n");
}

export function projectionFromResult(value: unknown): OperatorProjection | undefined {
  if (!value || typeof value !== "object" || !("projection" in value)) return undefined;
  return (value as { projection?: OperatorProjection }).projection;
}

export function cliGuidanceIdentity(projection: OperatorProjection) {
  return {
    stoppingPhaseId: projection.stoppingPhaseId,
    attentionTypes: projection.attention.map(({ type }) => type),
    actionTypes: projection.allowedActions.map(({ type }) => type),
  };
}
