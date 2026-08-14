## 1. Operator Projection Foundation

- [x] 1.1 Define versioned schemas and TypeScript types for operator projections, typed attention items, semantic actions, action parameters, and classified errors
- [x] 1.2 Implement a pure projection builder from reconstructed run state, resolved workflow configuration, artifacts, approvals, checkpoints, invocations, budgets, and delivery state
- [x] 1.3 Cover pending, running, paused, blocked, failed, cancelled, completed, and delivery-only states with projection unit tests
- [x] 1.4 Add projection fixtures for manual approval, blocked input, failed check, budget block, dependency failure, recoverable infrastructure failure, and completed local delivery
- [x] 1.5 Verify projection reconstruction is deterministic when snapshots or projection caches are absent

## 2. Service API and Command Results

- [x] 2.1 Add an authenticated operator-projection query for a selected run
- [x] 2.2 Include the resulting operator projection in workflow-entry and lifecycle command responses while preserving compatible existing fields
- [x] 2.3 Return the actual stopping phase and attention item when multi-phase progression stops before the final selected phase
- [x] 2.4 Return current projection and semantic actions when a submitted action is stale or no longer permitted
- [x] 2.5 Classify service errors as configuration, dependency, infrastructure, harness, work, check, policy, budget, or delivery failures with safe recovery metadata
- [x] 2.6 Ensure projections and errors pass through existing redaction and never include raw transcripts by default
- [x] 2.7 Add service integration tests for projection queries and post-mutation results across approval, request-changes, rejection, recovery, and completion

## 3. CLI Context and Selector Ergonomics

- [x] 3.1 Add shared CLI context resolution from current directory or `--cwd`, project configuration, change name, and bound run
- [x] 3.2 Support `swf status <change>` while retaining explicit `--project` and `--run` selection
- [x] 3.3 Support change-based approve, request-changes, reject, artifacts, costs, logs, and related routine commands
- [x] 3.4 Infer phase, gate, or invocation only when exactly one current attention item matches the requested action
- [x] 3.5 Render disambiguating alternatives and refuse mutation when shorthand resolution is ambiguous
- [x] 3.6 Update command help so the ordinary change-based syntax is primary and explicit IDs are documented as advanced selectors
- [x] 3.7 Add CLI contract tests for current-directory resolution, explicit selectors, missing bindings, and ambiguous attention

## 4. Human Output Rendering

- [x] 4.1 Introduce typed human renderers for workflow progress results, operator projections, evidence summaries, actions, approvals, failures, and delivery completion
- [x] 4.2 Replace default raw object serialization in workflow and lifecycle commands with concise state-aware output
- [x] 4.3 Render approval-required output with phase, reason, checks, changed paths, handoff risks, evidence references, and executable decision commands
- [x] 4.4 Render paused phase completion with checkpoint information, next phase, and one-phase versus automatic continuation commands
- [x] 4.5 Render approval and request-changes confirmations from resulting durable state rather than generic request acceptance
- [x] 4.6 Render completed local delivery with branch, target, dossier, checkpoint count, review command, and merge command
- [x] 4.7 Add `--verbose` detail for internal IDs, eligibility, artifacts, and diagnostics without including those details in default output
- [x] 4.8 Add snapshot or semantic rendering tests for representative human outputs without coupling tests to terminal color codes

## 5. JSON and Non-Interactive Contracts

- [x] 5.1 Ensure every `--json` command writes exactly one versioned JSON document to stdout with no SWF-generated progress or decoration
- [x] 5.2 Include typed attention, semantic actions, actual stopping phase, classified errors, and recovery guidance in JSON results
- [x] 5.3 Ensure JSON mode, non-TTY execution, and `--no-interactive` never prompt for input
- [x] 5.4 Define stdout/stderr routing for human progress, final summaries, diagnostics, and JSON data
- [x] 5.5 Add subprocess tests that parse stdout for successful and failed JSON commands and verify nonzero failure exit codes
- [x] 5.6 Add non-TTY tests proving output is line-oriented and free of ANSI control sequences

## 6. Live Progress

- [x] 6.1 Add a CLI progress subscriber using authenticated ordered SSE continuation and the command's project/run context
- [x] 6.2 Render bounded milestones for run, phase, work unit, harness status, check, gate, checkpoint, and delivery events
- [x] 6.3 Track event sequence IDs and reconnect without dropping or duplicating durable milestones
- [x] 6.4 Separate progress transport failures from workflow execution so final durable state remains authoritative
- [x] 6.5 Provide restrained TTY animation and line-oriented non-TTY progress with consistent semantic content
- [x] 6.6 Add integration tests for normal streaming, reconnect continuation, duplicate suppression, stream loss, and final-state reconciliation

## 7. Optional Interactive Decisions

- [x] 7.1 Define TTY and flag rules for enabling or disabling interactive choices, including `--no-interactive`
- [x] 7.2 Add an optional approval decision flow that offers review, approve, request changes, reject, and safe exit without defaulting to mutation
- [x] 7.3 Require explicit confirmation and preserve actor and reason semantics for all interactive mutations
- [x] 7.4 Add tests proving prompts never appear in JSON, CI, piped, redirected, or explicitly non-interactive use

## 8. Pi and Dashboard Consistency

- [x] 8.1 Expose operator projections through Pi status and control surfaces without duplicating raw-state interpretation
- [x] 8.2 Update Pi approval and continuation controls to use semantic action parameters from the service
- [x] 8.3 Update dashboard attention and next-action presentation to consume the shared projection contract
- [x] 8.4 Add cross-client contract tests proving CLI, Pi, and dashboard identify the same stopping phase, attention type, and allowed actions

## 9. Acceptance, Documentation, and Release Verification

- [x] 9.1 Add an end-to-end human journey covering initialization, Planning progress, manual approval guidance, approval confirmation, phase-by-phase continuation, and local-branch completion
- [x] 9.2 Add acceptance coverage for blocked input, failed work, failed checks, dependency unavailability, recoverable infrastructure failure, and ambiguous shorthand
- [x] 9.3 Verify explicit-ID automation remains compatible and JSON schemas remain versioned
- [x] 9.4 Update README usage to lead with human commands rather than shell-captured JSON
- [x] 9.5 Update installation, operations, architecture, project configuration, Pi extension, dashboard, and troubleshooting documentation with operator guidance behavior
- [x] 9.6 Run formatting, lint, type checking, unit, integration, E2E, OpenSpec validation, and Git whitespace verification
- [x] 9.7 Perform an opt-in live Pi/Herdr smoke test and retain evidence showing progress, approval guidance, next actions, and completed local delivery
