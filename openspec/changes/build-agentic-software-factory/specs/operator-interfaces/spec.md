## ADDED Requirements

### Requirement: Shared service API
The CLI, Pi extension, and web dashboard SHALL use the same authenticated local service API for run commands and queries, and the service SHALL remain the sole active-state authority.

#### Scenario: Approve through Pi
- **WHEN** a user approves a gate through the Pi extension
- **THEN** the extension submits the decision to the service and the same result becomes visible to CLI and dashboard clients

#### Scenario: Service is unavailable
- **WHEN** a client cannot reach the service
- **THEN** it reports the condition and does not independently mutate active run files

### Requirement: CLI operations and machine output
The system SHALL provide CLI operations for initialization, service lifecycle, run start/status/pause/resume/cancel, approval, rollback, events, artifacts, logs, costs, configuration explanation, and diagnostics, with stable JSON output and exit codes for automation.

#### Scenario: Query run status as JSON
- **WHEN** automation requests JSON status for a run
- **THEN** the CLI returns a versioned machine-readable response without interactive UI output

### Requirement: Pi operator experience
The Pi extension SHALL provide SWF commands or tools, current run and phase status, progress display, output inspection, and approval interactions without owning scheduler lifetime.

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
