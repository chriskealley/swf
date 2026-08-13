import type { OperatorAction, OperatorProjection } from "@swf/core";

export function interactionEnabled(input: {
  interactive?: boolean;
  noInteractive?: boolean;
  json?: boolean;
  stdinTty?: boolean;
  stdoutTty?: boolean;
  ci?: boolean;
}): boolean {
  return Boolean(
    input.interactive &&
      !input.noInteractive &&
      !input.json &&
      input.stdinTty &&
      input.stdoutTty &&
      !input.ci,
  );
}

export function approvalChoices(projection: OperatorProjection): Array<{
  label: string;
  action?: OperatorAction;
}> {
  const decisions = projection.allowedActions.filter(({ type }) =>
    ["inspect-evidence", "approve", "request-changes", "reject"].includes(type),
  );
  return [
    ...decisions.map((action) => ({ label: action.label, action })),
    { label: "Exit without changing the run" },
  ];
}

export async function runApprovalDecisionFlow(input: {
  projection: OperatorProjection;
  actor: string;
  choose: (
    choices: ReturnType<typeof approvalChoices>,
  ) => Promise<OperatorAction | undefined>;
  confirm: (action: OperatorAction) => Promise<boolean>;
  reason: (action: OperatorAction) => Promise<string | undefined>;
  submit: (command: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ status: "exited" | "review" | "cancelled" | "submitted"; result?: unknown }> {
  const selected = await input.choose(approvalChoices(input.projection));
  if (!selected) return { status: "exited" };
  if (selected.type === "inspect-evidence") return { status: "review" };
  if (!(await input.confirm(selected))) return { status: "cancelled" };
  const reason = await input.reason(selected);
  const result = await input.submit({
    type: selected.type,
    projectId: selected.parameters.projectId,
    runId: selected.parameters.runId,
    phaseId: selected.parameters.phaseId,
    gateId: selected.parameters.gateId,
    actorId: input.actor,
    reason,
  });
  return { status: "submitted", result };
}
