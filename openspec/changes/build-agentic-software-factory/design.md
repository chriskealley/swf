## Context

The repository currently contains a minimal TypeScript Pi extension, an initialized OpenSpec project, and no durable orchestration engine or tests. The target system is a local agentic software factory that turns exactly one OpenSpec change into exactly one durable SWF run. A run executes configurable phases through Herdr-managed agent harnesses, preserves evidence and contextual handoffs, enforces tests and approval policy, checkpoints Git state, and remains observable through a CLI, Pi extension, and web dashboard.

The supported harnesses are Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI. Their process controls, event formats, session capabilities, model selection, cost telemetry, and resume behavior differ. Herdr is the terminal multiplexer and execution substrate, but SWF—not terminal layout—must own workflow state and transition decisions.

Projects need committed, customizable factory definitions while large transcripts and run telemetry must not pollute Git. The service must remain running until the user terminates it and must recover durable runs after restart. The dashboard must provide a global index across registered projects with project-specific details and retained invocation output and spend.

## Goals / Non-Goals

**Goals:**

- Provide a durable domain core and persistent user-scoped service independent of any one client.
- Initialize committed project-owned defaults under `.swf/` and ignored operational state under `.swf-state/`.
- Bind one OpenSpec change to one SWF run with multiple phase attempts where needed.
- Execute sequential phases in one isolated Herdr-managed worktree and branch.
- Normalize multiple harnesses through capability-aware adapters without erasing harness-specific features.
- Collect deterministic evidence, preserve raw outputs, and ask the same phase agent for a schema-validated contextual handoff.
- Reuse artifacts only when their recorded inputs remain valid.
- Support command, agentic, OpenSpec, and human checks plus manual and delegated automatic approval.
- Expose the same operations and history through the CLI, Pi extension, local API, and web dashboard.
- Track exact, estimated, and unknown spend without reporting unknown cost as zero.
- Open a pull request by default and use approval policy to determine manual versus automatic merge behavior.
- Preserve a compact evidence dossier with the OpenSpec change while keeping complete operational history outside Git.

**Non-Goals:**

- Distributed or hosted execution in the initial implementation.
- Parallel write phases or multi-worktree task DAGs in the initial implementation.
- A lowest-common-denominator harness interface that promises unsupported capabilities.
- Treating natural-language claims as substitutes for deterministic test evidence.
- Committing raw transcripts, large logs, secrets, or the complete run event stream.
- Requiring Pi, the CLI, or a browser to remain open while a run executes.
- Direct merge as the default delivery mechanism.
- Automatic reuse of evidence across different Git commits in the initial implementation.

## Decisions

### 1. Separate the domain core, service, and clients

The system will consist of a pure TypeScript domain core, a persistent local service, integration adapters, and three peer clients: CLI, Pi extension, and web dashboard. The service is the sole writer of active run state and exposes a local authenticated API plus a live event stream. Clients request operations and render state; they do not independently schedule phases.

This prevents Pi session lifetime from controlling run lifetime and enables future CI or alternate clients. A CLI-owned process was rejected because disconnected terminals and dashboard continuity would be fragile. One supervisor per run was rejected because process discovery, aggregation, and upgrades become unnecessarily complex.

### 2. Use project-owned definitions and project-local ignored state

`swf init` will add customizable, version-controlled defaults under `.swf/`, including configuration, workflows, guidelines, harness/agent profiles, and policies. Runtime state will live under root-level `.swf-state/`, which initialization adds to `.gitignore`.

`.swf/` defines how the project operates. `.swf-state/` records what happened. A fresh clone receives workflow policy but not full local operational history.

### 3. Use a persistent user-scoped service with a global project index

A single service per user remains active until explicitly terminated. It owns scheduling, run locks, Herdr coordination, artifact registration, cost aggregation, and API/event delivery. A lightweight global registry under the user's configuration directory indexes known project roots; authoritative run data remains in each project's `.swf-state/`.

Service shutdown will stop accepting work, safely pause active execution where possible, flush state, and exit without semantically cancelling runs. Restart will reconcile Herdr resources and resume or report blocked work according to policy.

### 4. Model workflows as typed phases, work units, checks, and gates

A workflow contains ordered phases. A phase has an objective, executor configuration, guidelines, typed work units, expected artifacts, checks, and a transition gate. Initial work-unit types are agent, command, human, OpenSpec, and composite sequential work. Initial check types are command, agentic, OpenSpec, and human.

Checks produce evidence. Gates evaluate evidence and authorize transitions. Policy determines retries, escalation, timeout, budget, and whether a human approval requirement is manually decided or satisfied by delegated authorization. An agent saying it is done never directly advances a phase.

### 5. Use event-sourced JSONL state with rebuildable snapshots

Each run has a human-readable `run.json`, append-only `events.jsonl`, rebuildable snapshot, artifact manifest, raw logs, and invocation records. Events have immutable IDs, monotonic per-run sequence numbers, timestamps, actor identity, phase/attempt context, and typed payloads. Rollback and remediation append compensating events; history is never rewritten.

Snapshots are disposable accelerators. Current state must be reconstructable from events and static run metadata. Per-run locking and idempotency keys prevent competing writes and duplicate transitions.

### 6. Bind one OpenSpec change to one logical run

A concrete OpenSpec change has one immutable SWF run identity. Retries, resumes, phase reruns, remediation, rollback, and delivery monitoring remain inside that run as attempts and events rather than creating replacement runs. The binding stores both a generated run ID and the change identity so change-name reuse after archival cannot silently collide.

A compact dossier containing phase handoffs, evidence summaries, approvals, checkpoints, delivery references, and final report will be persisted with the OpenSpec change when compatible with OpenSpec validation and archival. Raw operational history remains in `.swf-state/`.

### 7. Treat Herdr as the supervised execution runtime

One isolated Herdr-managed Git worktree and SWF branch is created per run. Sequential phases share that worktree to retain repository continuity. SWF records every Herdr workspace, tab, pane, terminal, native harness session, branch, and worktree identifier it owns and never cleans up unrelated resources.

The runtime supports launch, prompt delivery, observation, blocked-input handling, cancellation, transcript collection, timeout, and reconciliation. Explicit Herdr agent integrations are required or validated where reliable status detection depends on them.

### 8. Use capability-aware harness adapters

A common adapter contract covers availability, configuration validation, launch, submit, observe, interrupt, resume, and result collection. Each adapter advertises structured events, resumability, model selection, tool restrictions, cost reporting, interactive approval, and other capabilities. Workflow resolution fails early when a requested capability is unavailable.

Pi is the reference adapter, followed by Codex, Claude Code, and Copilot. Every adapter must pass a shared conformance suite, but may retain namespaced harness-specific configuration.

### 9. Separate deterministic evidence from agent narrative

At phase completion SWF deterministically collects Git status and diff, commit range, changed files, command and test results, OpenSpec status, and other declared evidence. SWF then sends those facts back to the same contextual agent and requests a structured handoff containing summary, decisions, known issues, recommended next actions, and artifact references.

The handoff is schema-validated and cannot replace deterministic fields. If the original agent cannot produce it, SWF preserves a deterministic degraded handoff and applies configured retry or fallback policy. Later phases receive selected OpenSpec artifacts, relevant valid evidence summaries, and handoffs rather than all prior transcripts.

### 10. Make artifact reuse explicit and validity-bound

Artifacts are typed and include producer phase/attempt, input fingerprints, source commit, normalized command/configuration, status, output references, timestamps, and consumers. Initial reuse requires an exact source commit and matching normalized inputs. Changed inputs mark prior evidence stale; stale artifacts remain inspectable but cannot satisfy gates.

This deliberately favors correctness over aggressive caching. More selective dependency-aware reuse may be added later.

### 11. Record delegated approval rather than impersonating a human

Policy may auto-satisfy a human approval when a human has explicitly authorized autonomous operation for a recorded scope such as gate, phase, run, workflow, or project. The event actor is policy, the decision is `auto-approved`, and the authorization records who delegated it, when, scope, implications, and source configuration.

Risk rules can force manual review for sensitive paths, destructive operations, secrets findings, elevated risk, or budget thresholds. Clients must display the resolved autonomous implications before launch. Unknown or unavailable required approval fails closed.

### 12. Checkpoint phases in Git without requiring empty commits

A successful phase that modifies tracked content produces a checkpoint commit on the run branch. A phase with no tracked changes records a logical checkpoint at the unchanged commit instead of forcing an empty commit. Every checkpoint records before/after commit, artifact manifest, handoff, gate decision, and clean-tree status.

Rollback resets the run worktree to a prior checkpoint and appends invalidation events for later phase outcomes and artifacts. The operational event history remains intact.

### 13. Use PR-first delivery and separate execution from delivery status

After final checks, the default delivery action is to create or update a pull request. Under manual approval policy the run reports execution complete and delivery awaiting merge. Under delegated automatic policy the service requests auto-merge and continues observing hosted checks and merge state. Direct merge or local-branch-only delivery requires explicit project workflow configuration.

Execution status and delivery status are tracked separately so a completed workflow can remain `awaiting-merge`. Pull requests, hosted checks, reviews, merge results, and branch cleanup are typed delivery artifacts and events.

### 14. Provide a global dashboard backed by project-local truth

The dashboard lists all registered projects and aggregates active runs, waiting gates, failures, invocation history, and spend. Project detail displays OpenSpec linkage, phase timeline, worktree/branch, attempts, outputs, artifacts, costs, policy decisions, and PR delivery state. Missing or moved projects remain visible with an availability status.

Initial live updates will use ordinary local HTTP queries/commands plus Server-Sent Events. WebSockets are deferred until terminal-style bidirectional interaction is required. The service binds locally and requires a service credential.

### 15. Preserve output and cost at invocation granularity

The hierarchy is run, phase attempt, work-unit execution, harness invocation, and model turn. Each invocation records harness, model/provider, times, Herdr/native session IDs, prompt and output references, stop reason, exit status, token usage, cost, and retry ancestry. Cost quality is explicitly exact, estimated, or unknown; unknown is never rendered as zero.

## Risks / Trade-offs

- **[JSONL stores become expensive to scan]** → Maintain rebuildable snapshots and bounded indexes while preserving JSONL as source of truth.
- **[Ignored operational history is lost on a fresh clone or disk failure]** → Persist compact dossiers with changes and add explicit run export/import or backup later.
- **[Project roots move or disappear]** → Keep the global registry lightweight, detect availability, and support path reconciliation without copying authoritative state globally.
- **[Harness behavior and CLI output change between versions]** → Advertise capabilities, capture versions, fail validation early, and maintain adapter conformance tests.
- **[Herdr status integrations are absent or stale]** → Add doctor checks, installation guidance, timeouts, transcript inspection fallbacks, and explicit unknown/blocked states.
- **[Agent summaries contradict deterministic facts]** → Keep facts immutable, schema-validate references, label narrative separately, and prevent narrative from satisfying deterministic checks.
- **[Artifact reuse accepts stale evidence]** → Begin with exact-commit and exact-input matching; require explicit reruns after source changes.
- **[Autonomous approval hides risk]** → Record delegated authorization, show resolved implications before launch, apply risk overrides, budgets, and fail-closed defaults.
- **[Persistent service creates a local security boundary]** → Bind locally, authenticate clients, enforce project trust, redact secrets, protect state permissions, and audit mutating API calls.
- **[Phase commits create undesirable history]** → Use a dedicated run branch, avoid empty commits, and let final delivery policy control squash/rebase/merge behavior.
- **[One run per change prevents a clean restart after catastrophic failure]** → Model attempts, resets, rollback, and recovery within the durable run instead of minting another run.
- **[Dashboard scope drives premature complexity]** → Start with read-heavy global/project timelines and add advanced control only after the service API is stable.
- **[The initial scope is large]** → Deliver vertical milestones beginning with one Pi-driven sequential workflow before adding remaining harnesses and advanced policies.

## Migration Plan

1. Preserve the current minimal extension as a temporary compatibility entry while introducing shared packages/modules.
2. Define and version `.swf/` configuration, `.swf-state/` storage, event, workflow, artifact, handoff, and API schemas.
3. Add `swf init` to create project defaults and Git-ignore operational state.
4. Build the pure reducer, JSONL store, snapshots, project/run locks, and simulated adapters.
5. Add the persistent local service, global project registry, recovery, local API, and event stream.
6. Implement the Herdr runtime and Pi reference adapter in a single sequential vertical slice.
7. Add deterministic evidence, same-agent handoffs, exact-commit artifact reuse, checks, gates, and phase checkpoints.
8. Add CLI and Pi client functionality, then a minimal global dashboard consuming the same API.
9. Add PR-first delivery and monitoring, followed by Codex, Claude, and Copilot adapters.
10. Add richer remediation, risk policy, spend analytics, dossier archival, export/import, and operational hardening.

Rollback during development consists of disabling the service and returning to the minimal extension; all new project state is isolated under `.swf/`, `.swf-state/`, and the change dossier. Persisted formats must be versioned before release so migrations can be explicit and reversible.

## Open Questions

- Confirm the operational directory name (`.swf-state/` is the current recommendation).
- Confirm the exact custom evidence location and behavior when OpenSpec archives a change.
- Define whether service shutdown pauses active harnesses immediately or waits for a safe work-unit boundary by default.
- Select the local HTTP framework, web stack, JSON schema/validation library, and process/service installation mechanism.
- Define Git hosting abstraction boundaries and the first supported provider beyond local Git; GitHub is assumed for the first PR integration.
- Define default workflow phase names and starter profiles shipped by `swf init`.
- Define retention, pruning, redaction, and export policy for raw invocation outputs.
- Define whether final PR delivery defaults to squash, rebase, or repository-configured merge behavior.
