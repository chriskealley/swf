## Why

The current CLI exposes service response objects and internal identifiers rather than guiding an operator through a stateful workflow. Live use showed that operators could not readily tell whether work was progressing, why a run had stopped, when approval was required, what evidence to review, or which command should be run next.

## What Changes

- Add human-oriented CLI rendering that explains what happened, what needs attention, and what the recommended next action is.
- Add a service-owned operator projection with structured attention items and semantic next actions so CLI, Pi, dashboard, and JSON clients can remain consistent.
- Stream concise workflow, phase, harness, check, gate, checkpoint, and delivery progress when the CLI is attached to a terminal.
- Allow routine run inspection and lifecycle commands to resolve a project and run from the current directory and OpenSpec change name, while retaining explicit IDs for automation and disambiguation.
- Make approval-required output include the phase, gate, evidence and risk summary, allowed decisions, and directly executable follow-up commands.
- Make approval, phase completion, workflow completion, failure, and recovery output explicitly state the resulting status and next action.
- Preserve a stable, non-interactive `--json` contract, with semantic next actions represented as data rather than human prose.
- Keep interactive prompts optional and TTY-aware so scripts never block unexpectedly.

## Capabilities

### New Capabilities
- `operator-guidance`: Service and client behavior for attention summaries, semantic next actions, approval guidance, failure recovery guidance, and consistent operator-facing workflow projections.
- `cli-human-experience`: Human-readable rendering, live progress, ergonomic change-based selectors, optional interaction, and stable separation between terminal and JSON output modes.

### Modified Capabilities

None. The repository does not yet contain archived main capability specs; this change introduces focused capability contracts rather than modifying unpublished change-local specifications.

## Impact

- Affects the authenticated service query/command response contracts and event projection layer.
- Affects CLI command arguments, default rendering, progress consumption, approval flows, errors, and completion summaries.
- May provide reusable operator projections to the Pi extension and dashboard without changing the service-as-sole-writer architecture.
- Requires compatibility tests for JSON output, non-TTY execution, TTY progress, selector ambiguity, approvals, failures, recovery, and local-branch delivery guidance.
- Does not change workflow semantics, approval authority, security boundaries, or durable event ownership.
