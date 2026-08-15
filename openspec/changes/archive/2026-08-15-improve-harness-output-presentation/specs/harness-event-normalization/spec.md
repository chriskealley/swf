## ADDED Requirements

### Requirement: Common harness lifecycle events
SWF SHALL normalize supported native Pi, Claude Code, Codex CLI, and future harness protocols into a versioned common event model covering process startup, harness readiness, work start, message summary, tool start/update/end, blocked input, usage, retry, compaction, completion, settlement, cancellation, and failure.

#### Scenario: Pi prompt settles
- **WHEN** Pi RPC emits prompt acceptance, agent start, tool activity, final message, and `agent_settled`
- **THEN** SWF emits ordered common readiness, working, tool, message, usage, and settled events correlated to the owned invocation

#### Scenario: Codex item completes
- **WHEN** Codex JSONL reports an item or turn completing
- **THEN** SWF maps it to the corresponding common event without requiring other clients to understand Codex-native JSON

#### Scenario: Claude result completes
- **WHEN** Claude stream-json emits its terminal result and usage
- **THEN** SWF emits common completion, usage, and settled events with the Claude session reference

### Requirement: Preserve native distinctions
Normalization SHALL preserve materially different native semantics through typed optional fields or adapter-specific references rather than falsely claiming equivalent capabilities. Unsupported blocked input, resume, usage quality, or intermediate progress SHALL be explicit.

#### Scenario: Harness cannot accept blocked input
- **WHEN** a harness reports a condition that requires interaction but its adapter cannot resume or submit input
- **THEN** the normalized attention identifies that limitation instead of advertising a common reply action

#### Scenario: Usage is estimated
- **WHEN** a harness provides cost or token information that is incomplete or estimated
- **THEN** the normalized usage event retains the correct quality rather than labeling it exact

### Requirement: Ordered and correlated normalization
Every normalized event SHALL identify its project, run, phase, work unit, invocation, harness, native session when available, source sequence or cursor, and timestamp. Reprocessing the same native record SHALL not create duplicate durable milestones.

#### Scenario: Native event is replayed
- **WHEN** recovery rereads a native event already normalized
- **THEN** SWF recognizes its stable source identity or cursor and does not append a duplicate lifecycle transition

#### Scenario: Concurrent invocations exist
- **WHEN** multiple owned harness invocations emit events concurrently
- **THEN** every normalized event remains correlated to the correct invocation and phase

### Requirement: Reliable start and settlement semantics
Adapters SHALL distinguish process readiness, prompt acceptance, active work, low-level turn completion, and fully settled completion. Initial idle state SHALL NOT be interpreted as completion after a prompt until work start or an explicit terminal native event is observed.

#### Scenario: Prompt is accepted before working status updates
- **WHEN** a prompt is submitted while Herdr still reports the ready idle state
- **THEN** SWF waits for native work-start or terminal evidence and does not complete the invocation prematurely

#### Scenario: Retry follows a low-level completion
- **WHEN** a native harness reports a turn end followed by automatic retry or compaction recovery
- **THEN** SWF keeps the invocation active until the harness reports fully settled completion or terminal failure

### Requirement: Version-aware native parsers
Each harness adapter SHALL declare the native protocol versions or event shapes it supports and SHALL fail with actionable compatibility diagnostics when required native records cannot be safely interpreted.

#### Scenario: Unknown required event shape
- **WHEN** an installed harness emits an incompatible terminal event shape
- **THEN** normalization records bounded diagnostic evidence and fails closed rather than guessing that work completed

#### Scenario: Unknown optional event appears
- **WHEN** a harness adds an unrecognized optional event that is not needed for lifecycle correctness
- **THEN** SWF retains it in the raw stream, may record a diagnostic counter, and continues processing supported required events

### Requirement: Normalized service events
Significant common harness milestones SHALL be published through the authenticated service event stream for CLI, Pi, dashboard, and operational monitoring. High-frequency native deltas SHALL be coalesced or omitted from durable service events unless explicitly requested for diagnostics.

#### Scenario: Tool streams many updates
- **WHEN** a tool emits hundreds of partial output records
- **THEN** clients receive bounded start/progress/end milestones rather than hundreds of full native payloads

#### Scenario: Invocation blocks
- **WHEN** a normalized blocked-input event is emitted
- **THEN** the service publishes one durable attention milestone with the supported response action
