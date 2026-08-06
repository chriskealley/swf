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

Graceful service shutdown will stop accepting new work, wait for active work units to reach a safe boundary, pause remaining runs, flush durable state, and exit without semantically cancelling runs. Forced shutdown will interrupt SWF-owned execution, preserve partial output and recoverable state where possible, flush state, and exit without waiting for a safe boundary. Restart will reconcile Herdr resources and resume or report blocked work according to policy.

### 4. Model workflows as typed phases, work units, checks, and gates

A workflow contains ordered phases. A phase has an objective, executor configuration, guidelines, typed work units, expected artifacts, checks, and a transition gate. Initial work-unit types are agent, command, human, OpenSpec, and composite sequential work. Initial check types are command, agentic, OpenSpec, and human.

Checks produce evidence. Gates evaluate evidence and authorize transitions. Policy determines retries, escalation, timeout, budget, and whether a human approval requirement is manually decided or satisfied by delegated authorization. An agent saying it is done never directly advances a phase.

### 5. Use event-sourced JSONL state with rebuildable snapshots

Each run has a human-readable `run.json`, append-only `events.jsonl`, rebuildable snapshot, artifact manifest, raw logs, and invocation records. Events have immutable IDs, monotonic per-run sequence numbers, timestamps, actor identity, phase/attempt context, and typed payloads. Rollback and remediation append compensating events; history is never rewritten.

Snapshots are disposable accelerators. Current state must be reconstructable from events and static run metadata. Per-run locking and idempotency keys prevent competing writes and duplicate transitions.

### 6. Bind one OpenSpec change to one logical run

A concrete OpenSpec change has one immutable SWF run identity. Retries, resumes, phase reruns, remediation, rollback, and delivery monitoring remain inside that run as attempts and events rather than creating replacement runs. The binding stores both a generated run ID and the change identity so change-name reuse after archival cannot silently collide.

A compact dossier containing phase handoffs, evidence summaries, approvals, checkpoints, delivery references, and final report will be persisted at `openspec/changes/<change>/evidence/`. OpenSpec 1.6 archives by moving the entire change directory, including arbitrary supporting subdirectories, to `openspec/changes/archive/<date>-<change>/`; the dossier therefore remains attached to the archived change. Raw operational history remains in `.swf-state/`.

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

After final checks, the default delivery action is to create or update a GitHub pull request. Under manual approval policy the run reports execution complete and delivery awaiting authorization to merge. Under delegated automatic policy the service requests auto-merge and continues observing hosted checks and merge state. Once merge is authorized, the default method is a merge commit; projects may configure squash, rebase, or repository-default behavior. Direct merge or local-branch-only delivery requires explicit project workflow configuration.

Execution status and delivery status are tracked separately so a completed workflow can remain `awaiting-merge`. Pull requests, hosted checks, reviews, merge results, merge method, and branch cleanup are typed delivery artifacts and events. GitHub is the required initial hosting provider behind an adapter boundary, and the GitHub CLI (`gh`) is a required runtime dependency used for authentication and pull-request delivery.

### 14. Provide a global dashboard backed by project-local truth

The dashboard lists all registered projects and aggregates active runs, waiting gates, failures, invocation history, and spend. Project detail displays OpenSpec linkage, phase timeline, worktree/branch, attempts, outputs, artifacts, costs, policy decisions, and PR delivery state. Missing or moved projects remain visible with an availability status.

The local service and API will use Nitro. The dashboard will use Vite and Vue as a lightweight Nuxt-aligned stack. Initial live updates will use ordinary local HTTP queries/commands plus Server-Sent Events. WebSockets are deferred until terminal-style bidirectional interaction is required. The service binds locally and requires a service credential.

### 15. Preserve output and cost at invocation granularity

The hierarchy is run, phase attempt, work-unit execution, harness invocation, and model turn. Each invocation records harness, model/provider, times, Herdr/native session IDs, prompt and output references, stop reason, exit status, token usage, cost, and retry ancestry. Cost quality is explicitly exact, estimated, or unknown; unknown is never rendered as zero.

### 16. Standardize the implementation stack

Nitro will host the persistent local HTTP API and event endpoints. Vite and Vue will provide the dashboard as a lightweight Nuxt-aligned web stack. Zod will validate TypeScript-facing runtime inputs and support ergonomic inferred types; Ajv will validate versioned JSON Schema documents and interoperability boundaries. Citty will implement the CLI, nypm will support package-manager operations during setup, Consola will provide structured user-facing and service logging, and destr will safely parse configuration-oriented data where appropriate.

The selected libraries fit the UnJS ecosystem and minimize framework weight while retaining independent domain and persistence modules. Framework-specific types must not leak into the domain core.

### 17. Ship a standard five-phase workflow and reusable profiles

Initialization will create a default workflow with Planning, Building, Reviewing, Verifying, and Releasing phases. The matching default profiles are `planner`, `builder`, `reviewer`, `verifier`, and `releaser`. Projects may customize, replace, remove, or extend those phases and profiles.

The initialized catalog will also support reusable activities or optional workflows for designing, testing, documenting, and writing. These are building blocks rather than mandatory phases in every run.

### 18. Make raw-output pruning explicit and user-controlled

Raw invocation output is retained by default under `.swf-state/` until a user invokes pruning or enables a configured retention rule. The service will offer simple pruning by age, selected run, and storage budget, with dry-run reporting before deletion. Pruning removes eligible raw payloads but preserves run events, invocation metadata, cost records, summaries, artifact manifests, approvals, checkpoints, and the OpenSpec evidence dossier. Pruned references remain present and are marked unavailable because of retention policy.

### 19. Define installation, terminal, and project preflight requirements

The supported baseline runtime is macOS or Linux with Node.js `>=22.19.0`, a compatible Git release (`>=2.30.0` initially), Herdr, Pi, OpenSpec `>=1.6.0`, and GitHub CLI (`gh`). SWF will pin or declare compatible ranges for Herdr and Pi and reject known-incompatible versions. Native Windows remains preview-only while Herdr's Windows support is preview. Codex CLI, Claude Code CLI, and GitHub Copilot CLI are optional unless selected by a workflow.

OpenSpec should be pinned as an SWF package dependency where possible so core behavior does not depend on an arbitrary global installation. Pi remains required for the initial extension and reference harness. GitHub CLI is required for GitHub authentication, repository checks, pull-request creation, merge operations, and delivery monitoring.

Ghostty is not required. Herdr is the terminal multiplexer rather than a terminal emulator. Interactive Pi or Herdr operation requires a modern UTF-8, ANSI-capable interactive terminal; Ghostty, iTerm2, WezTerm, Kitty, macOS Terminal, GNOME Terminal, and comparable terminals are acceptable. The persistent service, JSON CLI usage, and dashboard do not require a particular terminal emulator.

`swf doctor` will perform non-mutating checks for operating system and architecture, executable presence and versions, PATH visibility, project trust and write access, Git repository/worktree support, Herdr service health, required Herdr integrations, selected harness readiness, GitHub authentication, local service ports, and interactive terminal capabilities when relevant.

`swf setup` will provide explicit, opt-in remediation. It may install Herdr through an official installer or detected package manager; install Pi, OpenSpec tooling, and optional Node-distributed harnesses through an npm-compatible manager; install Herdr agent integrations with `herdr integration install`; and offer supported installation guidance or commands for Node, Git, and `gh`. Every download or system modification must show its source, version, destination, and command and require user confirmation. SWF must verify the result after installation. It must never silently download a terminal emulator, invent a Git remote, or create/authenticate credentials without user interaction.

Because a Node-based CLI cannot repair a missing Node prerequisite, distribution will include documented bootstrap installation that verifies Node before installing SWF. Authentication remains an explicit user action even when setup can launch the relevant login flow.

The default Releasing phase requires a Git repository with a configured GitHub remote, network access, a resolvable target branch, valid `gh` authentication, branch push permission, pull-request creation permission, and merge or auto-merge permission when required by resolved policy. The remote defaults to `origin` and is configurable. These checks run before expensive workflow execution. A workflow explicitly configured for local-branch delivery may omit GitHub remote, authentication, and PR permissions.

### 20. Make exploration, Planning, and workflow execution the user entry points

SWF will not expose a public `swf create` command that produces an empty run. Work begins through `swf explore`, `swf new`, or `swf run`, so creation mechanics do not displace the Planning phase.

`swf explore [idea]` starts or resumes durable read-only ideation before an OpenSpec change or SWF run exists. Exploration may inspect the repository, research alternatives, and ask the human questions, but it must not modify application code, create the formal OpenSpec proposal, or advance a workflow. Its events, transcript, and distilled brief are stored under `.swf-state/explorations/<exploration-id>/`. The brief records problem, goals, non-goals, options, decisions, open questions, codebase findings, candidate scope, and candidate change name.

An exploration can be listed, shown, resumed, discarded, or explicitly promoted. `swf new <change> --from-exploration <id>` and `swf run <change> --from-exploration <id>` copy the selected distilled brief into a normalized Planning input and preserve its identity. Promotion must identify the exploration explicitly; clients must not silently use whichever exploration is newest. Discarding marks an exploration for later retention pruning rather than immediately destroying its history.

`swf new <change> --description <text>` validates preconditions, creates the OpenSpec scaffold and one-to-one run binding, selects and resolves the workflow, creates the isolated worktree, executes exactly the first eligible phase, evaluates its gate, checkpoints it, and then stops even when automatic policy could continue. In the default workflow that first phase is Planning. Planning owns creation and validation of `proposal.md`, `design.md`, capability specs, `tasks.md`, deterministic planning evidence, and the planning handoff. The description or exploration brief is Planning input rather than a pre-created proposal.

`swf run <change> --description <text>` is the automatic entry point. If no change or run exists, it performs the same creation and Planning behavior as `swf new` and then continues through eligible phases until completion, a blocking gate, failure, budget boundary, pause, or cancellation. If the run exists, `swf run <change>` resumes automatic progression from durable state. A supplied description is initialization input: an identical value is idempotent, while a differing value for an existing run is rejected rather than silently changing scope.

`swf next <change>` executes exactly one currently eligible phase, including all work, checks, gate evaluation, handoff, and checkpoint behavior, and then stops. `swf phase run <change> <phase-id>` executes exactly one named eligible phase and stops. A phase is eligible only when it exists in the selected workflow, all predecessors are completed, required artifacts remain valid, the worktree matches its checkpoint, no conflicting work is active, entry checks pass, required harness capabilities are available, policy permits execution, and budget remains.

Completed phases require explicit `swf phase rerun`; normal phase execution never repeats them accidentally. Before rerunning, SWF reports and requires authorization for downstream checkpoints, phases, artifacts, checks, and delivery state that will be invalidated. Individual deterministic checks may be refreshed through `swf check run <change> <check-id>` without pretending the containing phase completed. In the default workflow, testing is normally a check or activity within Verifying; a `testing` phase is addressable only when a project workflow actually defines one.

The durable OpenSpec change and run binding are created before the Planning harness starts. A failed Planning attempt therefore leaves a recoverable run whose Planning phase can be retried; a second `swf new` for the same identity is rejected. `swf resume` continues interrupted work using its prior single-phase or automatic mode, while an explicit `swf run` switches progression to automatic mode.

Operator commands and skills will include `swf-explore`, `swf-new`, `swf-run`, `swf-next`, `swf-phase`, `swf-status`, `swf-approve`, and artifact/history inspection. Thin harness-specific skills call the SWF service or CLI rather than reproducing workflow logic. SWF-launched phase agents receive role profiles and read-only run context, not mutating operator controls. The service marks child invocations with run, phase, invocation, and child-environment identifiers and rejects recursive orchestration unless a workflow explicitly permits it.

## Risks / Trade-offs

- **[JSONL stores become expensive to scan]** → Maintain rebuildable snapshots and bounded indexes while preserving JSONL as source of truth.
- **[Ignored operational history is lost on a fresh clone, disk failure, or user pruning]** → Persist compact dossiers with changes, preserve metadata and summaries after pruning, and add explicit run export/import or backup.
- **[Project roots move or disappear]** → Keep the global registry lightweight, detect availability, and support path reconciliation without copying authoritative state globally.
- **[Harness, Herdr, GitHub CLI, or Git behavior changes between versions]** → Declare compatible ranges, capture versions, fail installation and run preflight early, and maintain adapter conformance tests.
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
3. Add bootstrap documentation plus `swf setup` and `swf doctor` for required runtime, integration, terminal, GitHub CLI, authentication, and project preflight checks.
4. Add `swf init` to create the standard five-phase workflow, reusable profiles and activities, project defaults, and Git-ignored operational state.
5. Build the pure reducer, JSONL store, snapshots, project/run locks, and simulated adapters.
6. Add the persistent local service, global project registry, recovery, local API, and event stream.
7. Implement the Herdr runtime and Pi reference adapter in a single sequential vertical slice.
8. Add deterministic evidence, same-agent handoffs, exact-commit artifact reuse, checks, gates, and phase checkpoints.
9. Add CLI and Pi client functionality, then a minimal global dashboard consuming the same API.
10. Add `gh`-backed GitHub PR delivery and monitoring, followed by Codex, Claude, and Copilot adapters.
11. Add richer remediation, risk policy, spend analytics, dossier archival, export/import, and operational hardening.

Rollback during development consists of disabling the service and returning to the minimal extension; all new project state is isolated under `.swf/`, `.swf-state/`, and the change dossier. Persisted formats must be versioned before release so migrations can be explicit and reversible.

## Open Questions

No architectural open questions remain from the initial proposal. Lower-level implementation choices must remain consistent with the decisions above and may be refined during implementation without changing the specified behavior.
