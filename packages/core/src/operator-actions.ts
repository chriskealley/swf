import type { OperatorAction } from "./operator-projection.js";

/**
 * Semantic action types are operator vocabulary, not service command types.
 * Returns the service command a client must submit for an action, or
 * `undefined` when the action is informational and the operator acts outside
 * the service (reading evidence, reviewing or merging a branch by hand,
 * editing project configuration).
 *
 * This module is deliberately dependency-free so browser clients can import it
 * without pulling in the Node-only parts of the package.
 */
export function actionCommandType(action: OperatorAction): string | undefined {
  switch (action.type) {
    case "run-phase":
      return "next";
    case "continue-run":
      return "run";
    case "retry":
      return action.parameters.deliveryId ? "refresh-delivery" : "run";
    case "reply-to-invocation":
      return "blocked-input";
    case "approve":
    case "reject":
    case "request-changes":
    case "resume":
    case "reconcile":
      return action.type;
    case "inspect-evidence":
    case "review-delivery":
    case "merge-delivery":
    case "configure":
      return undefined;
  }
}
