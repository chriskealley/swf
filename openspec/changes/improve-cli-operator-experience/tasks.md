## 1. Operator Projection Foundation

- [ ] 1.1 Define versioned schemas and TypeScript types for operator projections, typed attention items, semantic actions, action parameters, and classified errors
- [ ] 1.2 Implement a pure projection builder from reconstructed run state, resolved workflow configuration, artifacts, approvals, checkpoints, invocations, budgets, and delivery state
- [ ] 1.3 Cover pending, running, paused, blocked, failed, cancelled, completed, and delivery-only states with projection unit tests
- [ ] 1.4 Add projection fixtures for manual approval, blocked input, failed check, budget block, dependency failure, recoverable infrastructure failure, and completed local delivery
- [ ] 1.5 Verify projection reconstruction is deterministic when snapshots or projection caches are absent

## 2. Service API and Command Results

- [ ] 2.1 Add an authenticated operator-projection query for a selected run
- [ ] 2.2 Include the resulting operator projection in workflow-entry and lifecycle command responses while preserving compatible existing fields
- [ ] 2.3 Return the actual stopping phase and attention item when multi-phase progression stops before the final selected phase
- [ ] 2.4 Return current projection and semantic actions when a submitted action is stale or no longer permitted
- [ ] 2.5 Classify service errors as configuration, dependency, infrastructure, harness, work, check, policy, budget, or delivery failures with safe recovery metadata
- [ ] 2.6 Ensure projections and errors pass through existing redaction and never include raw transcripts by default
- [ ] 2.7 Add service integration tests for projection queries and post-mutation results across approval, request-changes, rejection, recovery, and completion

## 3. CLI Context and Selector Ergonomics

- [ ] 3.1 Add shared CLI context resolution from current directory or `--cwd`, project configuration, change name, and bound run
- [ ] 3.2 Support `swf status <change>` while retaining explicit `--project` and `--run` selection
- [ ] 3.3 Support change-based approve, request-changes, reject, artifacts, costs, logs, and related routine commands
- [ ] 3.4 Infer phase, gate, or invocation only when exactly one current attention item matches the requested action
- [ ] 3.5 Render disambiguating alternatives and refuse mutation when shorthand resolution is ambiguous
- [ ] 3.6 Update command help so the ordinary change-based syntax is primary and explicit IDs are documented as advanced selectors
- [ ] 3.7 Add CLI contract tests for current-directory resolution, explicit selectors, missing bindings, and ambiguous attention

## 4. Human Output Rendering

- [ ] 4.1 Introduce typed human renderers for workflow progress results, operator projections, evidence summaries, actions, approvals, failures, and delivery completion
- [ ] 4.2 Replace default raw object serialization in workflow and lifecycle commands with concise state-aware output
- [ ] 4.3 Render approval-required output with phase, reason, checks, changed paths, handoff risks, evidence references, and executable decision commands
- [ ] 4.4 Render paused phase completion with checkpoint information, next phase, and one-phase versus automatic continuation commands
- [ ] 4.5 Render approval and request-changes confirmations from resulting durable state rather than generic request acceptance
- [ ] 4.6 Render completed local delivery with branch, target, dossier, checkpoint count, review command, and merge command
- [ ] 4.7 Add `--verbose` detail for internal IDs, eligibility, artifacts, and diagnostics without including those details in default output
- [ ] 4.8 Add snapshot or semantic rendering tests for representative human outputs without coupling tests to terminal color codes

## 5. JSON and Non-Interactive Contracts

- [ ] 5.1 Ensure every `--json` command writes exactly one versioned JSON document to stdout with no SWF-generated progress or decoration
- [ ] 5.2 Include typed attention, semantic actions, actual stopping phase, classified errors, and recovery guidance in JSON results
- [ ] 5.3 Ensure JSON mode, non-TTY execution, and `--no-interactive` never prompt for input
- [ ] 5.4 Define stdout/stderr routing for human progress, final summaries, diagnostics, and JSON data
- [ ] 5.5 Add subprocess tests that parse stdout for successful and failed JSON commands and verify nonzero failure exit codes
- [ ] 5.6 Add non-TTY tests proving output is line-oriented and free of ANSI control sequences

## 6. Live Progress

- [ ] 6.1 Add a CLI progress subscriber using authenticated ordered SSE continuation and the command's project/run context
- [ ] 6.2 Render bounded milestones for run, phase, work unit, harness status, check, gate, checkpoint, and delivery events
- [ ] 6.3 Track event sequence IDs and reconnect without dropping or duplicating durable milestones
- [ ] 6.4 Separate progress transport failures from workflow execution so final durable state remains authoritative
- [ ] 6.5 Provide restrained TTY animation and line-oriented non-TTY progress with consistent semantic content
- [ ] 6.6 Add integration tests for normal streaming, reconnect continuation, duplicate suppression, stream loss, and final-state reconciliation

## 7. Optional Interactive Decisions

- [ ] 7.1 Define TTY and flag rules for enabling or disabling interactive choices, including `--no-interactive`
- [ ] 7.2 Add an optional approval decision flow that offers review, approve, request changes, reject, and safe exit without defaulting to mutation
- [ ] 7.3 Require explicit confirmation and preserve actor and reason semantics for all interactive mutations
- [ ] 7.4 Add tests proving prompts never appear in JSON, CI, piped, redirected, or explicitly non-interactive use

## 8. Pi and Dashboard Consistency

- [ ] 8.1 Expose operator projections through Pi status and control surfaces without duplicating raw-state interpretation
- [ ] 8.2 Update Pi approval and continuation controls to use semantic action parameters from the service
- [ ] 8.3 Update dashboard attention and next-action presentation to consume the shared projection contract
- [ ] 8.4 Add cross-client contract tests proving CLI, Pi, and dashboard identify the same stopping phase, attention type, and allowed actions

## 9. Acceptance, Documentation, and Release Verification

- [ ] 9.1 Add an end-to-end human journey covering initialization, Planning progress, manual approval guidance, approval confirmation, phase-by-phase continuation, and local-branch completion
- [ ] 9.2 Add acceptance coverage for blocked input, failed work, failed checks, dependency unavailability, recoverable infrastructure failure, and ambiguous shorthand
- [ ] 9.3 Verify explicit-ID automation remains compatible and JSON schemas remain versioned
- [ ] 9.4 Update README usage to lead with human commands rather than shell-captured JSON
- [ ] 9.5 Update installation, operations, architecture, project configuration, Pi extension, dashboard, and troubleshooting documentation with operator guidance behavior
- [ ] 9.6 Run formatting, lint, type checking, unit, integration, E2E, OpenSpec validation, and Git whitespace verification
- [ ] 9.7 Perform an opt-in live Pi/Herdr smoke test and retain evidence showing progress, approval guidance, next actions, and completed local delivery
