## 1. Architecture and Project Foundation

- [x] 1.1 Define the package/module boundaries for domain core, persistence, service, integrations, CLI, Pi extension, and web dashboard
- [x] 1.2 Establish TypeScript build, lint, formatting, unit-test, integration-test, and end-to-end test commands
- [x] 1.3 Establish Nitro for the local service, Vite and Vue for the dashboard, Zod and Ajv for validation, and Citty, nypm, Consola, and destr for CLI, setup, logging, and safe parsing
- [x] 1.4 Define versioned schemas for project configuration, workflows, policies, profiles, and guidelines
- [x] 1.5 Define versioned schemas for runs, events, snapshots, invocations, artifacts, handoffs, approvals, checkpoints, and delivery records
- [x] 1.6 Add schema fixtures and validation tests for valid, invalid, and forward-incompatible documents
- [x] 1.7 Declare Node.js `>=22.19.0`, Git `>=2.30.0`, OpenSpec `>=1.6.0`, GitHub CLI, and compatible Herdr and Pi ranges as baseline requirements
- [x] 1.8 Implement non-mutating `swf doctor` checks for platform, architecture, executables, versions, PATH, permissions, terminal capabilities, Herdr integrations, selected harnesses, GitHub remote, and authentication
- [x] 1.9 Implement explicit opt-in `swf setup` remediation with source, version, destination, command preview, confirmation, and post-install verification
- [x] 1.10 Add supported installers or package-manager integrations for Herdr, Pi, OpenSpec tooling, GitHub CLI, and optional harnesses without silently changing the system
- [x] 1.11 Install and verify required Herdr agent integrations through `herdr integration install`
- [x] 1.12 Document Node bootstrap installation, macOS/Linux support, Windows preview status, compatible terminals, and why Ghostty is optional
- [x] 1.13 Add installation and diagnostics tests for missing, incompatible, optional, unauthenticated, declined, and successfully installed dependencies

## 2. Project Initialization and Configuration

- [x] 2.1 Implement trusted-project discovery and root resolution
- [x] 2.2 Implement `swf init` generation of committed `.swf/` defaults without overwriting existing customizations
- [x] 2.3 Add the default Planning, Building, Reviewing, Verifying, and Releasing workflow
- [x] 2.4 Add `planner`, `builder`, `reviewer`, `verifier`, and `releaser` profiles plus reusable designing, testing, documenting, and writing activities
- [x] 2.5 Add starter phase guidelines and manual, autonomous, and security-sensitive policies
- [x] 2.6 Create `.swf-state/` during initialization and add its root-relative entry to `.gitignore`
- [x] 2.7 Implement deterministic layered configuration merging from built-in through run-time overrides
- [x] 2.8 Preserve configuration provenance and implement resolved-configuration explanation
- [x] 2.9 Validate references and required harness capabilities before execution resources are created
- [x] 2.10 Test initialization idempotency, default workflow and profiles, conflict handling, configuration precedence, provenance, and invalid references

## 3. Domain Model and Event Store

- [x] 3.1 Implement typed run, phase, attempt, work-unit, check, gate, artifact, invocation, checkpoint, and delivery domain models
- [x] 3.2 Implement legal run and phase transition reducers with explicit blocked, failed, cancelled, skipped, and completed states
- [x] 3.3 Implement immutable event envelopes with IDs, per-run sequence numbers, actor identity, context, and typed payloads
- [x] 3.4 Implement append-only JSONL writing with atomicity, per-run locking, and idempotency protection
- [x] 3.5 Implement state reconstruction from `run.json` and ordered events
- [x] 3.6 Implement rebuildable snapshots with schema version and stale-snapshot detection
- [x] 3.7 Implement run creation with one-to-one OpenSpec change binding and duplicate-run rejection
- [x] 3.8 Model retries, phase reruns, remediation, reset, and rollback as attempts and appended events within the same run
- [x] 3.9 Add reducer, replay, concurrent-write, interrupted-write, duplicate-event, and corrupt-snapshot tests

## 4. Persistent Service and Project Registry

- [x] 4.1 Implement a single-instance user-scoped service with process lock, local endpoint metadata, and service credentials
- [x] 4.2 Implement the global project registry while keeping project `.swf-state/` as authoritative run storage
- [x] 4.3 Implement project registration, moved-path reconciliation, availability reporting, and permission-error handling
- [x] 4.4 Implement authenticated API queries for projects, runs, phases, invocations, artifacts, costs, configuration, and delivery
- [x] 4.5 Implement authenticated API commands for run start, pause, resume, cancel, approval, rejection, remediation, and rollback
- [x] 4.6 Implement ordered Server-Sent Event subscriptions with reconnect and last-event continuation
- [x] 4.7 Implement graceful service shutdown that stops new work, reports draining progress, waits for active work units to reach safe boundaries, pauses remaining runs, flushes state, and exits
- [x] 4.8 Implement forced shutdown that interrupts only SWF-owned execution, preserves partial and recoverable state, flushes state, and exits without waiting
- [x] 4.9 Implement startup recovery and reconciliation hooks for active runs
- [x] 4.10 Test single-service ownership, authentication, graceful and forced shutdown, restart recovery, disconnected clients, missing projects, and event-stream reconnection

## 5. Git and Herdr Runtime

- [x] 5.1 Implement Git repository, branch, worktree, status, diff, commit, reset, and clean-tree operations behind testable interfaces
- [x] 5.2 Implement one isolated SWF branch and Herdr-managed worktree per run
- [x] 5.3 Record ownership metadata for every SWF-created Herdr workspace, tab, pane, terminal, process, and worktree resource
- [x] 5.4 Implement Herdr launch, readiness wait, prompt submission, status observation, blocked detection, transcript collection, timeout, and cancellation
- [x] 5.5 Add Herdr integration diagnostics that verify required agent-status integrations and installed harness executables
- [x] 5.6 Implement reconciliation for missing, completed, blocked, and unknown Herdr resources after service restart
- [x] 5.7 Ensure cleanup only targets resources recorded as owned by the run
- [x] 5.8 Add isolated Herdr session integration tests for normal completion, blocking, timeout, cancellation, missing panes, and restart reconciliation

## 6. Workflow Scheduler and Pi Reference Adapter

- [x] 6.1 Implement ordered workflow and phase scheduling with typed agent, command, human, OpenSpec, and sequential composite work units
- [x] 6.2 Implement phase-specific harness, model, profile, guideline, timeout, retry, budget, and artifact-context resolution
- [x] 6.3 Define the harness adapter contract and capability advertisement model
- [x] 6.4 Implement availability and configuration validation for the Pi harness adapter
- [x] 6.5 Implement Pi launch, structured event observation, prompt delivery, tool/model selection, cancellation, result collection, and usage extraction through Herdr
- [x] 6.6 Implement blocked-agent input routing from the service to operator clients and back to the owned pane
- [x] 6.7 Implement a shared adapter conformance suite and make the Pi adapter pass every advertised capability
- [x] 6.8 Complete an end-to-end sequential run containing one Pi agent work unit and one command work unit in the shared run worktree
- [x] 6.9 Implement normalized Planning input from a description or explicitly selected exploration brief
- [x] 6.10 Implement default Planning production and validation of OpenSpec proposal, design, capability specs, tasks, evidence, and handoff
- [x] 6.11 Implement phase eligibility evaluation and explanations across dependencies, artifact validity, worktree state, concurrency, checks, capabilities, policy, and budget
- [x] 6.12 Implement explicit completed-phase rerun with downstream impact preview, authorization, and invalidation
- [x] 6.13 Prevent child phase invocations from mutating orchestration unless nested execution is explicitly permitted

## 7. Evidence, Artifact Reuse, and Handoffs

- [x] 7.1 Implement the typed artifact manifest and storage layout under `.swf-state/`
- [x] 7.2 Capture deterministic command results including normalized command, configuration fingerprint, commit, exit status, summary, and raw output reference
- [x] 7.3 Collect phase Git evidence including before/after commits, status, diff, changed files, and clean-tree state
- [x] 7.4 Collect declared OpenSpec status and validation evidence
- [x] 7.5 Implement artifact validity states and exact-commit plus exact-input reuse rules
- [x] 7.6 Mark dependent artifacts stale or invalid after source changes, remediation, reset, or rollback
- [x] 7.7 Implement declared downstream context selection using OpenSpec artifacts, valid evidence summaries, prior handoffs, and raw-output references
- [x] 7.8 Request a structured handoff from the same contextual phase agent after deterministic evidence collection
- [x] 7.9 Validate handoff schemas, preserve deterministic facts separately, and implement retry plus degraded deterministic fallback
- [x] 7.10 Implement bounded summaries and output references so raw transcripts are not injected by default
- [x] 7.11 Test valid reuse, stale evidence rejection, contradictory agent narrative, handoff failure, and selective context construction
- [x] 7.12 Implement durable exploration metadata, events, transcript, and brief storage under `.swf-state/explorations/`
- [x] 7.13 Implement read-only exploration execution with repository inspection, research, human questions, resume, and safe cancellation
- [x] 7.14 Implement schema-validated exploration briefs containing problem, goals, non-goals, options, decisions, open questions, codebase findings, candidate scope, and candidate name
- [x] 7.15 Implement explicit exploration list, show, resume, discard, and promotion operations without implicit latest-selection behavior
- [x] 7.16 Preserve exploration identity and brief as Planning input and include its compact foundation in the OpenSpec evidence dossier
- [x] 7.17 Test exploration read-only enforcement, resume, multiple-candidate selection, discard retention, and promotion into new and automatic runs

## 8. Checks, Gates, and Approval Policy

- [x] 8.1 Implement command checks backed by deterministic command-result artifacts
- [x] 8.2 Implement OpenSpec validation checks backed by OpenSpec evidence
- [x] 8.3 Implement schema-constrained agentic review checks and blocking finding records
- [x] 8.4 Implement human approval, rejection, and request-changes checks with actor and evidence context
- [x] 8.5 Implement `all`, `any`, threshold, advisory, and required-check transition gate evaluation
- [x] 8.6 Prevent stale, invalid, missing, or narrative-only evidence from satisfying required gates
- [x] 8.7 Implement delegated autonomous authorization with human identity, scope, acknowledgment, configuration source, and expiration
- [x] 8.8 Record automatic satisfaction as a policy `auto-approved` decision rather than a human decision
- [x] 8.9 Implement risk overrides for sensitive paths, destructive operations, secret findings, elevated risk, and budget thresholds
- [x] 8.10 Implement bounded retry and remediation loops with attempt, elapsed-time, and spend limits
- [x] 8.11 Implement individual declared-check refresh that records fresh evidence without completing the containing phase
- [x] 8.12 Test manual, autonomous, risk-overridden, unavailable-approver, timeout, individual check refresh, remediation, and budget-exhaustion scenarios

## 9. Phase Checkpoints, Rollback, and OpenSpec Dossier

- [x] 9.1 Create a phase commit after a successful gate when tracked content changed
- [x] 9.2 Record a logical checkpoint without an empty commit when a successful phase made no tracked changes
- [x] 9.3 Persist checkpoint evidence including commits, artifacts, handoff, gate decision, and clean-tree state
- [x] 9.4 Implement authorized rollback to a checkpoint and invalidation of later dependent outcomes
- [x] 9.5 Persist the portable dossier under `openspec/changes/<change>/evidence/`
- [x] 9.6 Verify that OpenSpec validation accepts the evidence subtree and archival moves it to the dated archived change directory
- [x] 9.7 Generate a compact change dossier containing phase handoffs, evidence manifest, approvals, checkpoints, delivery references, and final report
- [x] 9.8 Exclude secrets, raw transcripts, large logs, and full event history from committed dossier content
- [x] 9.9 Test rollback history preservation, checkpoint recovery, dossier generation, OpenSpec validation, and archived-change retention

## 10. CLI and Pi Client

- [x] 10.1 Implement CLI service start, status, stop, and diagnostic commands
- [x] 10.2 Implement CLI initialization, run lifecycle, approval, rollback, event, artifact, log, cost, and configuration commands
- [x] 10.3 Add versioned JSON output and stable exit codes for every automation-relevant CLI operation
- [x] 10.4 Replace the minimal Pi tool with service-backed SWF commands and tools
- [x] 10.5 Add Pi footer and widget status for current run, phase, work, checks, and spend
- [x] 10.6 Add Pi approval, rejection, request-changes, blocked-input, pause, resume, cancel, and rollback interactions
- [x] 10.7 Add compact and expanded Pi renderers for runs, invocations, artifacts, and retained output
- [x] 10.8 Restore Pi client state by querying the service after extension reload, session replacement, or Pi restart
- [x] 10.9 Implement `swf explore` start, list, show, resume, discard, and explicit promote commands
- [x] 10.10 Implement `swf new` to create and bind work, execute the first phase, checkpoint it, and always stop
- [x] 10.11 Implement `swf run` create-if-absent and existing-run automatic progression with idempotent description handling
- [x] 10.12 Implement `swf next` to execute exactly one eligible phase and stop
- [x] 10.13 Implement phase list, status, explain, run, rerun, and authorized skip commands
- [x] 10.14 Implement check list and individual check-run commands
- [x] 10.15 Reject conflicting descriptions for existing runs and duplicate `swf new` identities with actionable guidance
- [x] 10.16 Add canonical `.swf/` operator skills and thin Pi, Claude, Codex, and GitHub Copilot integrations for explore, new, run, next, phase, status, approval, and artifacts
- [x] 10.17 Inject child run, phase, invocation, and child-mode environment metadata and enforce recursive-orchestration restrictions
- [x] 10.18 Add CLI and skill contract tests for exploration promotion, Planning stop, automatic run, next-phase stop, ineligible phase, rerun invalidation, and child restrictions

## 11. Global Web Dashboard

- [x] 11.1 Create the authenticated dashboard shell and service API client
- [x] 11.2 Implement the global project index with availability, active runs, waiting gates, failures, recent invocations, and aggregate spend
- [x] 11.3 Implement project-specific active and historical run listings
- [x] 11.4 Implement run detail with OpenSpec identity, phase timeline, attempts, worktree, branch, outputs, artifacts, decisions, and costs
- [x] 11.5 Implement retained invocation output and artifact inspection with explicit truncation and raw-output retrieval
- [x] 11.6 Implement preview and confirmation controls for pruning raw output by age, selected run, or storage budget
- [x] 11.7 Implement live event updates with reconnect and ordered replay
- [x] 11.8 Add dashboard controls for safe run operations and approval decisions through the service API
- [x] 11.9 Display cost provenance as exact, estimated, or unknown at invocation, phase, run, project, and global levels
- [x] 11.10 Add dashboard security, accessibility, unavailable-project, stale-client, pruning, and live-update tests

## 12. Pull-Request Delivery

- [ ] 12.1 Define the Git hosting adapter contract and implement the initial GitHub adapter using required `gh` authentication and operations
- [ ] 12.2 Implement idempotent create-or-update pull-request delivery from the run branch to the configured target
- [ ] 12.3 Record pull request, hosted checks, reviews, merge state, and cleanup as artifacts and events
- [ ] 12.4 Track execution status separately from delivery status
- [ ] 12.5 Implement manual-policy behavior that opens a PR and awaits human merge by default
- [ ] 12.6 Implement autonomous-policy behavior that requests repository-supported auto-merge after final gates pass
- [ ] 12.7 Use merge commits by default and implement configurable squash, rebase, and repository-default pull-request merge methods
- [ ] 12.8 Require explicit configuration and resolved-policy authorization for local-branch-only or direct-merge delivery
- [ ] 12.9 Continue monitoring hosted checks and merge state after agent execution completes
- [ ] 12.10 Apply configured remediation or escalation when hosted checks fail or a PR is rejected or closed
- [ ] 12.11 Implement early GitHub delivery preflight for configurable remote, repository URL, network, target branch, `gh` authentication, push, PR creation, and merge permissions
- [ ] 12.12 Allow explicit local-branch workflows to bypass GitHub remote, authentication, and permission checks
- [ ] 12.13 Test missing remotes, non-GitHub remotes, authentication failures, permission failures, duplicate delivery, manual merge, auto-merge, merge-method selection, failed hosted checks, unsupported auto-merge, and direct-merge safeguards

## 13. Additional Harness Adapters

- [ ] 13.1 Investigate and document Codex CLI capabilities, structured output, native session, model, tool-policy, and usage interfaces
- [ ] 13.2 Implement the Codex CLI adapter and pass its advertised adapter conformance tests
- [ ] 13.3 Investigate and document Claude Code CLI capabilities, structured output, native session, model, tool-policy, and usage interfaces
- [ ] 13.4 Implement the Claude Code adapter and pass its advertised adapter conformance tests
- [ ] 13.5 Investigate and document GitHub Copilot CLI capabilities, structured output, native session, model, tool-policy, and usage interfaces
- [ ] 13.6 Implement the GitHub Copilot CLI adapter and pass its advertised adapter conformance tests
- [ ] 13.7 Add per-phase harness/model switching tests across a single sequential run
- [ ] 13.8 Add diagnostics and dashboard capability reporting for every installed adapter

## 14. Security, Retention, and Operational Hardening

- [ ] 14.1 Enforce local binding, service authentication, project trust, filesystem permissions, and mutating-operation audit events
- [ ] 14.2 Implement configurable secret and sensitive-value redaction before logs, events, artifacts, or API responses are persisted
- [ ] 14.3 Implement user-controlled dry-run and confirmed raw-output pruning by age, selected run, and storage budget while preserving required audit summaries and marking pruned references
- [ ] 14.4 Implement cost and token budgets at invocation, phase, run, project, and service scopes
- [ ] 14.5 Add stuck-agent detection, orphaned-resource reporting, and operator reconciliation commands
- [ ] 14.6 Implement versioned state migrations with dry-run, backup, and rollback support
- [ ] 14.7 Implement complete run export and import for operational-history backup and transfer
- [ ] 14.8 Add fault-injection tests for service crashes, partial events, full disks, permission failures, network failures, and harness version changes
- [ ] 14.9 Add an end-to-end acceptance suite using disposable repositories, isolated Herdr sessions, simulated models, and selected live harness smoke tests
- [ ] 14.10 Document installation, required and optional dependencies, GitHub remote setup, initialization, service operation, autonomous-policy implications, recovery, dashboard use, and adapter support matrix
