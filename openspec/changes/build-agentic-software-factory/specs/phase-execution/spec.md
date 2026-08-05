## ADDED Requirements

### Requirement: Isolated run worktree
The system SHALL create or adopt one isolated Git worktree and SWF branch for a run, and sequential phases SHALL share that worktree.

#### Scenario: Start the first phase
- **WHEN** a valid run begins execution
- **THEN** the system establishes an isolated worktree and branch and records their identifiers before launching the phase harness

#### Scenario: Advance to the next sequential phase
- **WHEN** a phase gate passes
- **THEN** the next phase uses the same run worktree at the successful phase checkpoint

### Requirement: Typed phase execution
The system SHALL execute ordered workflow phases containing typed agent, command, human, OpenSpec, or sequential composite work units.

#### Scenario: Execute mixed phase work
- **WHEN** a phase defines an agent work unit followed by a command work unit
- **THEN** the system runs them in declared order and records independent status and output for each

#### Scenario: Work unit fails
- **WHEN** a work unit fails or times out
- **THEN** the system applies the configured retry, remediation, escalation, or stop policy without implicitly completing the phase

### Requirement: Capability-aware harness adapters
The system SHALL provide adapters for Pi, Codex CLI, Claude Code CLI, and GitHub Copilot CLI that advertise supported capabilities and normalize availability, launch, submission, observation, interruption, resume, and result collection.

#### Scenario: Select a configured harness and model
- **WHEN** a phase resolves a supported harness, model, and profile
- **THEN** the system validates the selection and launches that harness with the resolved configuration

#### Scenario: Harness lacks required capability
- **WHEN** execution requires a capability not advertised by the adapter
- **THEN** the system blocks before launch with a capability mismatch rather than silently degrading behavior

### Requirement: Herdr resource supervision
The system SHALL use Herdr as the terminal execution substrate, record every resource it creates, and SHALL NOT inspect, mutate, or remove unrelated resources as part of run cleanup.

#### Scenario: Launch an agent work unit
- **WHEN** an agent work unit starts
- **THEN** the system creates or selects an SWF-owned Herdr context, launches the configured harness, waits for readiness, submits work, and records pane, terminal, and native session metadata

#### Scenario: Agent requests input
- **WHEN** Herdr or the harness reports that an agent is blocked
- **THEN** the system exposes the request to operator clients and follows configured human-intervention policy

### Requirement: Cancellation and timeout
The system SHALL propagate cancellation and timeout to active harness or command execution and SHALL record whether termination was graceful, forced, or indeterminate.

#### Scenario: User cancels active work
- **WHEN** an authorized user cancels a running work unit
- **THEN** the system interrupts the owned process or harness, preserves partial output, and records the resulting state

### Requirement: Adapter conformance
Every harness adapter SHALL pass a shared conformance suite for all capabilities it advertises.

#### Scenario: Adapter advertises resume
- **WHEN** an adapter declares resume support
- **THEN** its conformance tests demonstrate recovery of a persisted native session or fail the adapter validation
