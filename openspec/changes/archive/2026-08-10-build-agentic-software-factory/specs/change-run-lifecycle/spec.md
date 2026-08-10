## ADDED Requirements

### Requirement: One change maps to one run
The system SHALL bind each concrete OpenSpec change to exactly one immutable SWF run identity while allowing multiple attempts, retries, resumes, remediations, and rollbacks within that run.

#### Scenario: Create a run for an unbound change
- **WHEN** a user starts a valid OpenSpec change that has no SWF run
- **THEN** the system creates one run and records both its generated run ID and OpenSpec change identity

#### Scenario: Attempt to create a duplicate run
- **WHEN** a user invokes `swf new` for an OpenSpec change already bound to a run
- **THEN** the system rejects creation and directs the user to resume, run, advance, or inspect the existing run

### Requirement: Durable Planning startup
The system SHALL persist the OpenSpec change scaffold and one-to-one run binding before launching the first Planning attempt so startup failures remain recoverable within the same run.

#### Scenario: Planning fails after creation
- **WHEN** the first Planning attempt fails after the change and run are bound
- **THEN** the run remains durable with Planning failed or blocked and can be retried without creating another run

#### Scenario: Repeated automatic entry is idempotent
- **WHEN** `swf run` is repeated for an existing run with no conflicting initialization input
- **THEN** the system resumes that run rather than creating duplicate change or run state

### Requirement: Persistent service ownership
The system SHALL use one persistent user-scoped service as the sole writer and scheduler for active runs, and the service SHALL remain operational until explicitly terminated by the user.

#### Scenario: Client exits during execution
- **WHEN** the Pi client, CLI command, or dashboard disconnects while a run is active
- **THEN** the service continues the run according to workflow and policy

#### Scenario: Competing service starts
- **WHEN** a second service instance attempts to claim the same user scope
- **THEN** it fails without modifying run state and reports the existing service endpoint

### Requirement: Graceful and forced service shutdown
By default, service shutdown SHALL stop accepting new work, wait for active work units to reach a safe boundary, pause remaining runs, flush durable state, and then exit. A force option SHALL interrupt SWF-owned active execution, preserve partial and recoverable state where possible, flush state, and exit without waiting for a safe boundary.

#### Scenario: Graceful shutdown with active work
- **WHEN** the user requests normal service shutdown while a work unit is active
- **THEN** the service reports that it is draining, waits for the work unit's safe boundary, pauses unfinished runs, persists state, and exits

#### Scenario: Forced shutdown with active work
- **WHEN** the user requests forced service shutdown while a work unit is active
- **THEN** the service interrupts only SWF-owned execution, preserves partial output and recoverable state where possible, records the forced interruption, flushes state, and exits

### Requirement: Append-only durable history
The system SHALL persist human-readable, monotonically sequenced JSON events for every material run, phase, work, check, gate, artifact, harness, cost, checkpoint, rollback, and delivery transition.

#### Scenario: Rebuild state without snapshot
- **WHEN** a run snapshot is missing or stale
- **THEN** the system reconstructs current state from run metadata and the ordered event stream

#### Scenario: Roll back a phase
- **WHEN** a run rolls back to an earlier checkpoint
- **THEN** the system appends rollback and invalidation events without deleting or rewriting prior history

### Requirement: Recovery and reconciliation
The system SHALL recover durable runs after service restart and SHALL reconcile recorded execution resources with current Herdr, Git, and process state before proceeding.

#### Scenario: Restart with an active run
- **WHEN** the service restarts while a run was recorded as active
- **THEN** it inspects owned resources and resumes, pauses, completes, or marks the work blocked based on observed state and policy

#### Scenario: Owned pane is missing
- **WHEN** reconciliation cannot find a recorded SWF-owned Herdr pane
- **THEN** the system preserves history and transitions the affected work to an explicit recoverable or failed state rather than assuming success

### Requirement: Global project registry
The service SHALL maintain a lightweight global index of registered projects while authoritative run state remains in each project's `.swf-state/` directory.

#### Scenario: Project path is unavailable
- **WHEN** an indexed project root cannot be accessed
- **THEN** the project remains visible with an unavailable status and no fabricated current run data

#### Scenario: Register a project
- **WHEN** an initialized project first connects to the service
- **THEN** the service records stable project identity, display name, root path, and last-seen metadata
