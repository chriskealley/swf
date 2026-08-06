## ADDED Requirements

### Requirement: Shared service API
The CLI, Pi extension, and web dashboard SHALL use the same authenticated local service API for run commands and queries, and the service SHALL remain the sole active-state authority.

#### Scenario: Approve through Pi
- **WHEN** a user approves a gate through the Pi extension
- **THEN** the extension submits the decision to the service and the same result becomes visible to CLI and dashboard clients

#### Scenario: Service is unavailable
- **WHEN** a client cannot reach the service
- **THEN** it reports the condition and does not independently mutate active run files

### Requirement: Workflow entry commands
The CLI SHALL use `swf explore`, `swf new`, and `swf run` as the public work entry points and SHALL NOT require a separate public command that creates an empty run before Planning.

#### Scenario: Start Planning and stop
- **WHEN** a user runs `swf new <change> --description <text>` for a new identity
- **THEN** the system creates and binds the OpenSpec change and SWF run, executes the first workflow phase, and stops after that phase completes

#### Scenario: Start automatic execution
- **WHEN** a user runs `swf run <change> --description <text>` for a new identity
- **THEN** the system creates and binds the change and run, executes Planning, and continues through eligible phases until blocked, failed, paused, cancelled, budget-limited, or completed

#### Scenario: Resume automatic execution
- **WHEN** a user runs `swf run <change>` for an existing run
- **THEN** the system resumes automatic progression from durable state without creating another run

#### Scenario: Description conflicts with existing scope
- **WHEN** a user supplies a description for an existing run that differs from its recorded Planning input
- **THEN** the command rejects the implicit scope change and directs the user to an explicit revision flow

### Requirement: Controlled phase execution commands
The CLI SHALL provide `swf next <change>` to execute exactly one eligible phase and `swf phase run <change> <phase-id>` to execute exactly one named eligible phase, with both commands stopping after that phase.

#### Scenario: Run the next phase
- **WHEN** a user invokes `swf next` and one phase is eligible
- **THEN** the system executes that phase through its checks, gate, handoff, and checkpoint and does not automatically start the following phase

#### Scenario: Named phase is ineligible
- **WHEN** a user requests a phase whose predecessors, artifacts, worktree state, entry checks, harness capabilities, policy, or budget do not satisfy eligibility
- **THEN** the system does not execute it and explains every blocking condition and the next eligible action

### Requirement: CLI operations and machine output
Using Citty, the system SHALL provide CLI operations for setup, non-mutating doctor checks, initialization, explore/new/run/next, phase and check control, graceful and forced service lifecycle, status/pause/resume/cancel, approval, rollback, events, artifacts, logs, raw-output pruning, costs, configuration explanation, and diagnostics, with stable JSON output and exit codes for automation.

#### Scenario: Query run status as JSON
- **WHEN** automation requests JSON status for a run
- **THEN** the CLI returns a versioned machine-readable response without interactive UI output

#### Scenario: Doctor finds an incomplete installation
- **WHEN** a user runs `swf doctor` and a required dependency, Herdr integration, GitHub remote, or authentication state is missing or incompatible
- **THEN** the CLI reports the failing check, required remediation, and whether `swf setup` can perform it

#### Scenario: Setup requires a download
- **WHEN** `swf setup` can download or install a missing dependency
- **THEN** it requests explicit confirmation before making the change and verifies the installation afterward

#### Scenario: Observe graceful service shutdown
- **WHEN** a user requests normal service shutdown
- **THEN** the CLI displays draining progress until the service reaches safe boundaries, pauses remaining runs, flushes state, and exits

#### Scenario: Force service shutdown
- **WHEN** a user explicitly requests forced shutdown
- **THEN** the CLI warns about interruption, requests the force operation, and reports the resulting persisted recovery state

### Requirement: Cross-harness operator skills
The system SHALL provide thin operator skills or native commands for explore, new, run, next, phase, status, approval, and artifact inspection that call the SWF service or CLI rather than implementing workflow logic in prompts.

#### Scenario: Promote the current exploration through an operator skill
- **WHEN** a user asks a supported outer harness to start Planning from an explicitly selected exploration
- **THEN** the skill invokes the corresponding SWF operation with that exploration identity and reports service state

#### Scenario: Child phase agent attempts recursive orchestration
- **WHEN** an SWF-launched child agent invokes a mutating operator command without explicit nested-orchestration permission
- **THEN** the service rejects the command and preserves the parent run state

### Requirement: Pi operator experience
The Pi extension SHALL provide SWF commands or tools, current exploration/run and phase status, progress display, output inspection, and approval interactions without owning scheduler lifetime.

#### Scenario: Pi exits during a run
- **WHEN** the operator closes Pi
- **THEN** the run remains active in the service and is restored in the Pi display when the extension reconnects

### Requirement: Global dashboard
The web dashboard SHALL present a global index of registered projects and SHALL provide project-specific active and historical run detail.

#### Scenario: View all projects
- **WHEN** a user opens the dashboard
- **THEN** it displays registered projects with availability, active runs, waiting gates, failures, recent invocation activity, and aggregate spend

#### Scenario: View project run detail
- **WHEN** a user selects a project and run
- **THEN** the dashboard displays OpenSpec identity, phases, attempts, worktree and branch, outputs, artifacts, policy decisions, costs, and delivery status

#### Scenario: Manage raw-output retention
- **WHEN** a user opens project storage controls
- **THEN** the dashboard can preview user-selected age, run, or storage-budget pruning and submit confirmed pruning through the service API

### Requirement: Live updates and retained output
The service SHALL stream ordered run events to connected clients and SHALL retain historical output references after invocation completion.

#### Scenario: Agent output arrives
- **WHEN** a harness invocation emits progress or completes
- **THEN** connected clients receive ordered updates and can later inspect the retained invocation output

### Requirement: Invocation and spend accounting
The system SHALL track run, phase attempt, work-unit execution, harness invocation, and model-turn hierarchy, and SHALL classify cost as exact, estimated, or unknown.

#### Scenario: Harness reports token usage and price
- **WHEN** reliable provider or harness telemetry is available
- **THEN** the invocation and aggregate views report the measured usage and cost with its provenance

#### Scenario: Cost cannot be determined
- **WHEN** an invocation lacks sufficient telemetry
- **THEN** clients display cost as unknown rather than zero

### Requirement: Local service security
The service SHALL bind to a local interface by default, authenticate clients, enforce project trust for executable project configuration, protect state file permissions, and redact configured secrets from retained output and API responses.

#### Scenario: Unauthenticated dashboard request
- **WHEN** a request lacks valid service credentials
- **THEN** the service denies access without exposing project or run metadata
