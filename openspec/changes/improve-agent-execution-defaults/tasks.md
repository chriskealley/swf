## 1. Model Tier Configuration

- [x] 1.1 Add versioned schemas and TypeScript types for model tiers, harness-specific concrete mappings, explicit model overrides, ordered fallback, and harness-default opt-in
- [x] 1.2 Extend configuration loading and provenance to resolve model tiers across built-in, user, project, workflow, phase, and runtime layers
- [x] 1.3 Implement deterministic resolution from phase tier to selected harness and concrete model with explicit override precedence
- [x] 1.4 Reject unresolved, unavailable, or capability-incompatible model routes before Herdr runtime resources are created
- [x] 1.5 Integrate model-route admission with hierarchical budgets and strict-unknown usage policy without dynamic model substitution
- [x] 1.6 Record tier, concrete model, harness, provenance, overrides, and fallback in phase explanations, invocations, artifacts, and dossiers
- [x] 1.7 Add unit tests for precedence, mappings, explicit overrides, retries, fallback opt-in, missing routes, capabilities, and budgets

## 2. Generated Model Defaults and Configuration UX

- [x] 2.1 Generate `reasoning`, `coding`, and `fast` model-tier configuration templates without hard-coding provider credentials or silently choosing concrete models
- [x] 2.2 Update default profiles so Planning uses `reasoning`, Building uses `coding`, Reviewing uses `reasoning`, Verifying uses `fast`, and Releasing declares no model
- [x] 2.3 Add diagnostics that list unresolved tier mappings and exact configuration locations before a workflow begins
- [x] 2.4 Add a preview-first model-mapping configuration flow that lets operators explicitly bind tiers to installed harness models
- [x] 2.5 Ensure existing profiles with direct concrete `model` settings remain compatible and take documented precedence
- [x] 2.6 Document tier semantics as project policy labels rather than universal cross-provider model rankings

## 3. Structured Phase Contracts and Prompt Builder

- [x] 3.1 Add schemas for phase objective, responsibilities, allowed scope, prohibited actions, required inputs, required outputs, completion criteria, and handoff expectations
- [x] 3.2 Implement a bounded prompt builder that combines resolved contracts, project guidelines, OpenSpec context, current valid evidence, tools, runtime boundaries, and completion criteria
- [x] 3.3 Preserve contract and prompt-input fingerprints and configuration provenance without placing raw prompts in portable dossiers
- [x] 3.4 Exclude stale evidence and raw transcripts from authoritative downstream prompt context by default
- [x] 3.5 Extend phase explanation to show the resolved contract, tier, model, tools, evidence references, and completion criteria with redaction
- [x] 3.6 Add prompt-builder tests for precedence, bounded context, stale evidence, redaction, and deterministic fingerprints

## 4. Default Planning, Building, and Reviewing Contracts

- [x] 4.1 Replace the generic Planning guideline with a contract requiring scoped OpenSpec artifacts, alternatives, risks, strict validation, evidence, and handoff
- [x] 4.2 Enforce Planning's planning-only mutation boundary and prohibit implementation, archive, merge, and delivery operations
- [x] 4.3 Replace the generic Building guideline with a contract requiring approved task execution, truthful checkboxes, implementation tests, deviations, evidence, and handoff
- [x] 4.4 Prevent Building from archiving the change or performing merge and delivery operations
- [x] 4.5 Replace the generic Reviewing guideline with an independent structured review contract covering correctness, security, regressions, maintainability, and missing tests
- [x] 4.6 Make Reviewing read-only by default and require separate explicit remediation authorization before review findings can cause code mutation
- [x] 4.7 Add contract and service integration tests proving each phase receives distinct responsibilities and prohibited actions

## 5. OpenSpec Task Verification

- [x] 5.1 Implement stable parsing and referencing of OpenSpec task sections, task identifiers, normalized text, and checkbox state
- [x] 5.2 Define and implement a versioned task-audit artifact mapping each task to implementation references, checks, evidence freshness, review blockers, and conclusion
- [x] 5.3 Require every applicable task to be checked and supported by current implementation and verification evidence before Verifying can complete
- [x] 5.4 Reject stale, missing, contradictory, or insufficient task evidence and identify the affected tasks
- [x] 5.5 Require unresolved actionable Reviewing findings to be remediated with current evidence before verification succeeds
- [x] 5.6 Run strict OpenSpec validation and all adopted required project checks as deterministic Verifying evidence
- [x] 5.7 Prevent verifier narrative output from overriding failed, missing, stale, or unknown required checks
- [x] 5.8 Keep the Verifying prompt focused on task completion, specification conformance, checks, and evidence rather than general code review
- [x] 5.9 Add unit and integration tests for unchecked tasks, false checked claims, stale evidence, unresolved findings, failed checks, complete audits, and plan revisions

## 6. Deterministic Releasing

- [x] 6.1 Remove the general-purpose agent work unit and model requirement from newly generated default Releasing phases
- [x] 6.2 Implement deterministic release preflight for prior phase completion, evidence validity, source checkpoint, target refresh, dirty state, conflicts, remote, branch, and policy
- [x] 6.3 Persist the final pre-delivery dossier before any merge or hosted delivery mutation
- [x] 6.4 Add a release-specific manual approval gate that summarizes source, target, merge method, evidence, checks, risks, and cleanup plan
- [x] 6.5 Require scoped recorded delegated authorization before automatic release or merge and ensure Planning approval does not authorize delivery
- [x] 6.6 Implement configured local merge behavior with recorded source, target, merge method, and resulting commit
- [x] 6.7 Integrate pull-request creation, update, merge observation, and authorized automatic merge into the deterministic Releasing state machine
- [x] 6.8 Preserve branch, worktree, evidence, and diagnostic resources on merge conflict, hosted failure, or delivery failure
- [x] 6.9 Persist final delivery references and dossier updates before cleanup begins
- [x] 6.10 Clean only recorded owned panes, tabs, workspaces, worktrees, and optionally configured source branches after successful delivery
- [x] 6.11 Make OpenSpec archive a separate explicit deterministic workflow action and never infer it from Releasing
- [x] 6.12 Add integration tests for manual release, autonomous release, missing authorization, local merge, PR delivery, target drift, conflict, failure preservation, archive opt-in, and owned cleanup

## 7. Default Checks and Read-Only Discovery

- [x] 7.1 Implement read-only detection of recognized project manifests and conventional build, typecheck, lint, test, and validation scripts
- [x] 7.2 Represent each discovered candidate with exact command, source, proposed phase, cwd, timeout, and required status
- [x] 7.3 Ensure discovery and preview never execute scripts, install dependencies, or modify project configuration
- [x] 7.4 Add a preview-and-confirm adoption flow for selected checks into committed workflow configuration
- [x] 7.5 Report a fail-closed verification gap when code verification is expected but no required project checks have been adopted
- [x] 7.6 Add fixture tests for supported manifests, shell-containing scripts, monorepos, unknown project types, empty candidates, selective adoption, and no-execution guarantees

## 8. Versioned Default Template Lifecycle

- [x] 8.1 Add template version and generated-file provenance metadata to newly initialized `.swf/` configuration
- [x] 8.2 Implement read-only inspection of installed defaults and three-way comparison against adopted base metadata and current project files
- [x] 8.3 Classify files and settings as unchanged, project-only, upstream-only, removed, or conflicting
- [x] 8.4 Implement previewed selective adoption with exact changes, confirmation, private backup or recoverable patch, and provenance update
- [x] 8.5 Refuse automatic replacement for overlapping project/template conflicts and generate manual reconciliation guidance
- [x] 8.6 Ensure startup, registration, diagnostics, upgrades, and workflow execution never silently migrate or execute new defaults
- [x] 8.7 Add tests for unchanged adoption, project customization, clean upstream update, conflict, selective profile adoption, backup, rollback, and older projects without metadata

## 9. Operator Interfaces and Cross-Client Visibility

- [x] 9.1 Expose effective model routes, contract fingerprints, task audits, release authorization, delivery result, and cleanup state through authenticated service queries
- [x] 9.2 Add CLI commands or extensions for model mapping preview, phase explanation, check discovery, defaults inspection, defaults diff, and selective adoption
- [x] 9.3 Surface model route and verification/release evidence in dashboard phase and run views
- [x] 9.4 Surface the same resolved phase and model information through Pi controls without reimplementing resolution client-side
- [ ] 9.5 Integrate model, verification, release, and template attention with the operator projections defined by `improve-cli-operator-experience` when that change is available

## 10. Acceptance, Documentation, and Release Verification

- [x] 10.1 Add an end-to-end run proving static tier selection for Planning, Building, Reviewing, and Verifying and no model invocation for Releasing
- [x] 10.2 Add acceptance coverage proving Reviewing and Verifying have distinct contracts and that every OpenSpec task requires current evidence
- [x] 10.3 Add acceptance coverage for release approval, authorized automatic merge, delivery failure preservation, final dossier, and owned cleanup
- [x] 10.4 Add acceptance coverage proving check discovery and default updates are read-only until explicitly adopted
- [x] 10.5 Update README and installation, project configuration, architecture, harness adapter, operations, delivery, and troubleshooting documentation
- [x] 10.6 Document migration paths for direct-model existing profiles, unmapped tiers, template metadata absence, and custom release workflows
- [x] 10.7 Run formatting, lint, type checking, unit, integration, E2E, OpenSpec validation, and Git whitespace verification
- [x] 10.8 Perform an opt-in live Pi/Herdr run using distinct concrete models for at least two tiers and retain evidence of deterministic verification and agent-free Releasing
