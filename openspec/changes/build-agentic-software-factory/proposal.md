## Why

Software changes coordinated across multiple agent harnesses currently depend on transient terminal sessions, repeated discovery, and informal human intervention. A durable software factory is needed to turn OpenSpec changes into auditable, resumable workflows that can execute through Herdr, preserve evidence between phases, enforce configurable gates, and expose progress through Pi, a CLI, and a web dashboard.

## What Changes

- Add installation diagnostics and opt-in setup for Node.js, Git, Herdr, Pi, OpenSpec, GitHub CLI, Herdr integrations, selected optional harnesses, and project delivery prerequisites.
- Add project initialization that creates version-controlled factory configuration, workflows, guidelines, agent profiles, and policies under `.swf/`, including the default Planning, Building, Reviewing, Verifying, and Releasing workflow with matching role profiles.
- Add a persistent user-scoped SWF service with a durable workflow engine, local API, project registry, live event stream, graceful draining, and explicit forced shutdown.
- Establish a one-to-one relationship between an OpenSpec change and an SWF run, with retryable phase attempts and resumable state.
- Add durable read-only `swf explore` sessions that produce planning briefs without creating an OpenSpec change or formal proposal.
- Add `swf new` to create the change/run, execute Planning, generate and validate the OpenSpec planning artifacts, checkpoint Planning, and stop.
- Add `swf run` as a create-if-absent or resume entry point that continues automatically, plus `swf next` and named phase/check commands for controlled execution.
- Execute sequential workflow phases in a shared, isolated Herdr-managed Git worktree and checkpoint successful phases.
- Add capability-aware adapters for Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI.
- Persist append-only operational history, invocation output, snapshots, spend, and artifacts in a Git-ignored root-level `.swf-state/` directory.
- Produce deterministic evidence and a structured same-agent handoff after each phase so later phases can reuse valid work rather than repeat it.
- Add command, agentic, OpenSpec, and human checks with configurable transition gates, retries, remediation, and manual or policy-delegated approval.
- Add an SWF CLI, Pi extension, generated cross-harness operator skills, and persistent web dashboard with a global project index and project-specific run detail.
- Separate outer operator controls from child phase-agent profiles and prevent accidental recursive workflow orchestration.
- Add GitHub PR-first delivery: open a pull request by default, let approval policy authorize merging, use merge commits by default, and allow projects to configure squash, rebase, or repository-default merge behavior.
- Persist a compact, portable evidence dossier at `openspec/changes/<change>/evidence/`, which OpenSpec moves with the full change directory during archival, while retaining complete operational history outside Git.
- Add simple user-controlled pruning of raw invocation output while preserving compact evidence and audit history.

## Capabilities

### New Capabilities
- `factory-project-configuration`: Project initialization, committed `.swf/` configuration, workflow definitions, guidelines, profiles, policies, and resolved configuration provenance.
- `change-run-lifecycle`: One-to-one OpenSpec change/run identity, durable service ownership, event-sourced state, phase transitions, recovery, and project registration.
- `phase-execution`: Herdr worktree orchestration, sequential phase execution, harness capability adapters, attempts, cancellation, and checkpointing.
- `evidence-and-handoffs`: Typed artifacts, validity and reuse, deterministic evidence collection, structured same-agent handoffs, and portable change dossiers.
- `checks-and-gates`: Deterministic, agentic, OpenSpec, and human checks; transition gates; autonomous authorization; retries; and remediation policy.
- `operator-interfaces`: Exploration, new/run/next/phase/check commands, cross-harness operator skills, Pi extension, local service API, global web dashboard, live status, history, invocation output, and spend reporting.
- `git-delivery`: Phase commits, rollback, branch and worktree handling, GitHub pull-request creation, approval-aware merging, configurable merge methods, and delivery monitoring.

### Modified Capabilities

None.

## Impact

- Replaces the current minimal Pi tool with a multi-module TypeScript system containing a domain core, persistent Nitro service, integration adapters, Citty CLI, Pi extension, and Vite/Vue web application.
- Introduces Zod and Ajv validation plus the UnJS ecosystem utilities nypm, Consola, and destr.
- Introduces project-level `.swf/` and `.swf-state/` conventions plus global user service configuration and project indexing.
- Requires Node.js `>=22.19.0`, Git `>=2.30.0`, compatible Herdr and Pi versions, OpenSpec `>=1.6.0`, and GitHub CLI; Codex CLI, Claude Code CLI, and GitHub Copilot CLI remain optional unless selected.
- Integrates with OpenSpec, Herdr, Git, GitHub through required `gh`, Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI.
- Requires a compatible modern terminal only for interactive Pi/Herdr operation; Ghostty is supported but not required.
- Introduces local API and event-stream contracts, workflow and policy schemas, append-only JSONL event storage, artifact manifests, and structured handoff formats.
- Requires comprehensive unit, simulation, adapter conformance, Herdr integration, recovery, security, and end-to-end testing.
