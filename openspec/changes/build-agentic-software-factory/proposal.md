## Why

Software changes coordinated across multiple agent harnesses currently depend on transient terminal sessions, repeated discovery, and informal human intervention. A durable software factory is needed to turn OpenSpec changes into auditable, resumable workflows that can execute through Herdr, preserve evidence between phases, enforce configurable gates, and expose progress through Pi, a CLI, and a web dashboard.

## What Changes

- Add project initialization that creates version-controlled factory configuration, workflows, guidelines, agent profiles, and policies under `.swf/`.
- Add a persistent user-scoped SWF service with a durable workflow engine, local API, project registry, and live event stream.
- Establish a one-to-one relationship between an OpenSpec change and an SWF run, with retryable phase attempts and resumable state.
- Execute sequential workflow phases in a shared, isolated Herdr-managed Git worktree and checkpoint successful phases.
- Add capability-aware adapters for Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI.
- Persist append-only operational history, invocation output, snapshots, spend, and artifacts in a Git-ignored root-level `.swf-state/` directory.
- Produce deterministic evidence and a structured same-agent handoff after each phase so later phases can reuse valid work rather than repeat it.
- Add command, agentic, OpenSpec, and human checks with configurable transition gates, retries, remediation, and manual or policy-delegated approval.
- Add an SWF CLI, Pi extension, and persistent web dashboard with a global project index and project-specific run detail.
- Add PR-first Git delivery: open a pull request by default, await manual merge under manual policy, and request auto-merge when autonomous policy authorizes it.
- Persist a compact, portable evidence dossier with the OpenSpec change while retaining full operational history outside Git.

## Capabilities

### New Capabilities
- `factory-project-configuration`: Project initialization, committed `.swf/` configuration, workflow definitions, guidelines, profiles, policies, and resolved configuration provenance.
- `change-run-lifecycle`: One-to-one OpenSpec change/run identity, durable service ownership, event-sourced state, phase transitions, recovery, and project registration.
- `phase-execution`: Herdr worktree orchestration, sequential phase execution, harness capability adapters, attempts, cancellation, and checkpointing.
- `evidence-and-handoffs`: Typed artifacts, validity and reuse, deterministic evidence collection, structured same-agent handoffs, and portable change dossiers.
- `checks-and-gates`: Deterministic, agentic, OpenSpec, and human checks; transition gates; autonomous authorization; retries; and remediation policy.
- `operator-interfaces`: Consistent CLI, Pi extension, local service API, global web dashboard, live status, history, invocation output, and spend reporting.
- `git-delivery`: Phase commits, rollback, branch and worktree handling, pull-request creation, manual merge defaults, autonomous auto-merge, and delivery monitoring.

### Modified Capabilities

None.

## Impact

- Replaces the current minimal Pi tool with a multi-module TypeScript system containing a domain core, persistent service, integration adapters, CLI, Pi extension, and web application.
- Introduces project-level `.swf/` and `.swf-state/` conventions plus global user service configuration and project indexing.
- Integrates with OpenSpec, Herdr, Git, GitHub, Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI.
- Introduces local API and event-stream contracts, workflow and policy schemas, append-only JSONL event storage, artifact manifests, and structured handoff formats.
- Requires comprehensive unit, simulation, adapter conformance, Herdr integration, recovery, security, and end-to-end testing.
