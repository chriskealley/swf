# Implementation Verification Report

- Change: `build-agentic-software-factory`
- Verified: 2026-08-09
- Result: **NOT archive-ready**
- OpenSpec artifact validation: passed
- Build/static checks: passed
- Unit tests: 77 passed
- Integration tests: 29 passed
- End-to-end tests: 3 passed, 1 opt-in live smoke test skipped

## Method

This audit traced every specification requirement to production code and tests. A helper or unit test was classified as **component-only** when no authenticated service/API/client path invokes it. Component-only behavior does not satisfy an operator-visible `SHALL` scenario by itself.

Statuses:

- **Implemented** — reachable through production wiring and covered by relevant tests.
- **Component-only / partial** — implementation primitives exist, but required production integration or scenario coverage is absent.
- **Missing / incorrect** — no conforming path exists, or the production path contradicts the requirement.

## Executive findings

The automated suite is green, but it does not prove the proposed system. The central orchestration path is absent:

1. `SwfService` never constructs or invokes `WorkflowScheduler`, `HarnessWorkExecutor`, `CheckpointManager`, check executors, handoff generation, dossier generation, or `ExplorationStore`.
2. The public command model has no create/new/next/phase/check/exploration operations. `start` only appends a run-status transition.
3. The CLI aliases `new`, `run`, and `next` to the same `start` command and requires an already-existing run ID. Exploration commands query projects or submit ordinary run lifecycle commands.
4. Service rollback appends rollback events but does not call Git reset or invalidate persisted artifacts.
5. Approval commands directly mark gates satisfied/rejected without creating typed approval records, request-changes decisions, evidence context, or delegated authorization.
6. Core E2E tests manually assemble the event store, runtime, scheduler, and fake adapters; they do not execute through the persistent service, authenticated API, or CLI.

These are release-blocking gaps, not documentation-only findings.

## Requirement traceability

### `factory-project-configuration`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Baseline installation requirements | Implemented | `packages/core/src/requirements.ts`, `doctor.ts`; version and missing-tool tests pass. |
| Terminal compatibility | Implemented | Capability-based diagnostic and documentation; no Ghostty requirement. |
| Diagnostics and opt-in remediation | Implemented with minor defect | Doctor/setup are present and tested. Doctor remediation text uses `swf setup --install <id>` while the CLI accepts a positional install target. |
| Project initialization | Implemented | `initializeProject` creates `.swf/`, `.swf-state/`, trust, and ignore rules without overwriting. |
| Project-owned defaults | Implemented | Existing `.swf/` returns conflicts and is preserved. |
| Default workflow and profiles | Implemented | Five phases and matching profiles are generated. |
| Reusable workflow activities | Implemented | Designing, testing, documenting, and writing activities are generated. |
| Canonical operator skills | Component-only / partial | Generated skills are generic one-line delegators; several delegated CLI operations do not implement their stated semantics. |
| Layered configuration resolution | Component-only / partial | Resolver and provenance work in unit tests, but the service orchestration path never resolves phase execution configuration. |
| Configuration validation | Component-only / partial | File/reference validation exists. Actual adapter capability validation is performed only by an unwired executor, not by service preflight before resource creation. |

### `change-run-lifecycle`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| One change maps to one run | Component-only / partial | `RunEventStore.create` and duplicate bindings work, but no service/API/CLI entry creates a run. Production calls occur only in tests/E2E fixtures. |
| Durable Planning startup | Missing | No public entry persists a scaffold/run and then launches Planning. |
| Persistent service ownership | Implemented | Single-instance lock, metadata, credentials, registry, API, and persistent lifetime exist. |
| Graceful and forced shutdown | Component-only / partial | Shutdown logic exists, but real scheduler work never registers with `activeWork`; tests inject fake work registrations. |
| Append-only durable history | Implemented for emitted events | JSONL locking, idempotency, interrupted-tail repair, reconstruction, and snapshots are implemented. Many required workflow events are never emitted because orchestration is absent. |
| Recovery and reconciliation | Missing / partial | Delivery monitoring recovers. General startup recovery defaults to pausing; it does not inspect recorded Herdr/Git/process resources. The runtime reconcile helper is not called by startup recovery. |
| Global project registry | Component-only / partial | Registry/API work, including unavailable roots. `swf init` does not register the initialized project with the service. |

### `checks-and-gates`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Typed checks produce evidence | Component-only | Command, OpenSpec, agent-review, and human evidence helpers exist only in core/tests. |
| Manual check refresh | Missing in production | `refreshCheck` exists, but `swf check run` submits generic remediation and does not execute the selected check. |
| Gates control transitions | Missing in production | `evaluateGate` is unit-tested but never called by the service. |
| Manual approval | Incorrect | Service `approve`/`reject` directly appends `gate.decided`; it does not persist `ApprovalSchema` records, evidence context, or request-changes decisions. |
| Delegated automatic approval | Component-only | `recordAutoApproval` exists but is not used by service policy execution. |
| Risk and fail-closed overrides | Component-only | Risk functions are unit-tested but not applied to service gates or delivery authorization. |
| Bounded retries and remediation | Component-only | Retry decision helper exists; no service loop enforces it. |

### `evidence-and-handoffs`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Durable read-only exploration | Missing in production | `ExplorationStore` exists only in core/tests. Its executor receives a read-only environment, but the store does not itself enforce repository immutability. |
| Explicit exploration promotion | Missing in production | No exploration service query/command exists. CLI exploration list/show query projects; start/resume/discard/promote submit ordinary run commands. |
| Typed artifact catalog | Component-only / partial | Artifact store is implemented and delivery uses it. Normal phase execution never records artifacts through service orchestration. |
| Validity-bound artifact reuse | Component-only | Exact-commit/input functions exist only in core/tests. |
| Deterministic phase evidence | Component-only | Git/command/OpenSpec capture helpers are not invoked by a service phase finalizer. |
| Same-agent structured handoff | Component-only | Request/fallback logic exists but has no production caller. |
| Selective downstream context | Component-only | Context selector exists but is not used to launch service-managed phases. |
| Portable change dossier | Component-only | Dossier persistence/validation helpers exist; no completion/delivery path generates a dossier. This change currently has no `dossier.json`. |
| Operational history isolation | Implemented | Runtime state/raw output are under ignored `.swf-state/`; portable dossier helpers exclude raw history. |
| User-controlled raw-output pruning | Implemented | Authenticated preview/confirmation, age/run/budget selection, durable retention markers, CLI, and dashboard controls exist. |

### `git-delivery`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Phase checkpoints | Component-only | `CheckpointManager` commits/logically checkpoints correctly in tests, but service phase completion never invokes it. |
| Rollback to checkpoint | **Incorrect and unsafe** | `CheckpointManager.rollback` is correct in isolation. Service rollback does not use it; it appends attempt/rollback events without resetting Git or invalidating artifact storage. |
| GitHub delivery preflight | Implemented | `gh` adapter checks remote, repository, network, target, auth, push, PR, merge, and auto-merge. Local branch skips GitHub checks. |
| Pull-request-first delivery | Implemented for completed fixture runs | Delivery orchestration and idempotent PR update are wired and tested. No real workflow can currently reach completion through the service. |
| Approval-aware merge behavior | Partial / incorrect authorization source | Manual and auto-merge mechanics exist. Delegation is inferred from a policy-authored satisfied gate event rather than a typed, scoped, unexpired authorization record. |
| Explicit alternative delivery modes | Implemented | Local branch/direct merge guards and policy checks exist. |
| Configurable merge method | Implemented | Merge/squash/rebase/repository-default behavior is tested. |
| Separate execution/delivery status | Implemented | Delivery records retain execution status independently. |
| Delivery monitoring | Implemented | Hosted checks/reviews/merge/cleanup and restart monitoring are wired and tested. |

### `operator-interfaces`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Shared service API | Implemented for existing operations | CLI, Pi, and dashboard use authenticated service routes; clients do not directly mutate state. |
| Workflow entry commands | **Missing** | CLI `new`, `run`, and `next` all require project/run IDs and map to `start`; they cannot create a change/run, accept a description, or control progression mode. |
| Controlled phase execution | **Missing** | Phase run is generic `start`; rerun is generic remediation; skip is run cancellation; explain returns the same phase listing. |
| CLI operations and machine output | Partial | Many names/JSON wrappers exist, but exploration/new/next/phase/check semantics are absent and no CLI behavior test suite exists. |
| Cross-harness operator skills | Partial | Thin skills are generated, but delegate to incomplete CLI semantics. |
| Pi operator experience | Partial | Query, approval, blocked input, pause/resume/cancel/rollback and status restoration exist. Explore/new/run/next/phase operator flows are absent. |
| Global dashboard | Implemented for available service data | Global/project/run views, controls, output, artifacts, cost, adapters, budgets, and pruning are present. |
| Live updates and retained output | Implemented | Ordered SSE replay/reconnect and output inspection are wired. |
| Invocation and spend accounting | Partial | Cost quality aggregation exists. Persisted invocation schema omits work-unit identity, model/provider, Herdr/native session IDs, prompt reference, stop reason, retry ancestry, and model-turn hierarchy required by design/spec. |
| Local service security | Implemented | Loopback binding, bearer auth, project trust, private permissions, origin checks, redaction, and audit logging exist. |

### `phase-execution`

| Requirement | Status | Evidence / gap |
| --- | --- | --- |
| Isolated run worktree | Component-only | `RunRuntime.prepare` works in tests/E2E, but no service start path invokes it. |
| Planning owns OpenSpec artifacts | Missing in production | A template-writing helper exists, but it is not called by service/CLI and does not run a Planning harness to produce change-specific proposal/design/spec/tasks. |
| Typed phase execution | Component-only / partial | Scheduler ordering exists. No production command/OpenSpec/human executor set or service integration exists. |
| Capability-aware adapters | Component-only / partial | All four adapters and diagnostics exist; service only reports availability and never selects one to execute phase work. |
| Herdr resource supervision | Component-only / partial | Runtime ownership and Herdr controls exist. Blocked routing is not connected to any service-launched invocation. |
| Eligibility and explicit reruns | Missing in production | Eligibility/rerun preview helpers exist, but service `start` does not evaluate them and remediation does not perform invalidation. |
| Cancellation and timeout | **Incorrect** | Service cancel only appends a cancelled run transition; it does not interrupt active owned execution or preserve/record termination outcome. |
| Adapter conformance | Implemented at simulated-test level | Shared conformance tests cover advertised adapter capabilities. Installed Claude is currently unauthenticated; live smoke remains opt-in and skipped by default. |

## Test coverage limitations

- Service tests create runs directly through `RunEventStore.create`; they do not test public run creation.
- Service lifecycle tests demonstrate status-event mutation, not phase execution.
- Service rollback tests inject checkpoint events manually and assert only state history, not Git reset.
- E2E acceptance manually composes `RunRuntime`, `WorkflowScheduler`, and a fake Herdr runner; it bypasses service/API/CLI.
- There are no CLI integration tests for actual command parsing and behavior.
- The selected live harness test is skipped unless explicitly enabled.

## Installed dependency observations

Non-mutating checks during this audit found:

- Node `24.16.0`
- Git `2.55.0`
- Herdr `0.7.4`; `pane run`, `send-text`, `send-keys`, and `wait agent-status` are available
- Pi `0.83.0`
- OpenSpec `1.6.0`
- GitHub CLI `2.96.0`, authenticated
- Codex CLI `0.146.0`, authenticated
- Claude Code `2.1.222`, **not authenticated**
- GitHub Copilot CLI `0.0.358`

Claude is optional unless selected, so its authentication state is not a baseline blocker.

## Release-blocking remediation

Before archival, the implementation needs an end-to-end service orchestration vertical slice that:

1. registers initialized projects and creates a change/run from description or explicit exploration;
2. prepares the owned worktree and Herdr workspace;
3. resolves workflow/profile/policy configuration and adapter capabilities;
4. executes typed work, records invocation/output/cost hierarchy, routes blocked input, and supports real cancellation;
5. executes checks, evaluates gates, records typed approvals/authorization/risk decisions, and bounds retries;
6. collects deterministic evidence and same-agent handoffs;
7. creates checkpoints and performs real authorized rollback/invalidation;
8. writes the portable dossier and triggers delivery;
9. recovers owned resources after restart; and
10. is exercised through authenticated API plus real CLI entry commands in disposable-repository E2E tests.

Until those items are complete, the 160/160 task count should not be interpreted as specification compliance and the change should not be archived.
