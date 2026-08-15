## MODIFIED Requirements

### Requirement: Common harness lifecycle events
SWF SHALL normalize supported native Pi, Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, and future harness protocols into a versioned common event model covering process startup, harness readiness, work start, message summary, tool start/update/end, blocked input, usage, retry, compaction, completion, settlement, cancellation, and failure.

#### Scenario: Pi prompt settles
- **WHEN** Pi RPC emits prompt acceptance, agent start, tool activity, final message, and `agent_settled`
- **THEN** SWF emits ordered common readiness, working, tool, message, usage, and settled events correlated to the owned invocation

#### Scenario: Codex item completes
- **WHEN** Codex JSONL reports an item or turn completing
- **THEN** SWF maps it to the corresponding common event without requiring other clients to understand Codex-native JSON

#### Scenario: Claude result completes
- **WHEN** Claude stream-json emits its terminal result and usage
- **THEN** SWF emits common completion, usage, and settled events with the Claude session reference

#### Scenario: Copilot ACP prompt completes
- **WHEN** Copilot ACP emits correlated session updates and a terminal prompt response
- **THEN** SWF emits common message, tool, usage when available, completion, and settled events with the Copilot session reference

#### Scenario: OpenCode structured run completes
- **WHEN** OpenCode ACP or documented JSON events report tool activity, assistant output, and terminal completion
- **THEN** SWF emits the equivalent common lifecycle while retaining the selected OpenCode transport and native event references

### Requirement: Reliable start and settlement semantics
Adapters SHALL distinguish process readiness, protocol initialization, prompt acceptance, active work, low-level message or tool completion, terminal prompt response, and fully settled completion. Initial idle state SHALL NOT be interpreted as completion after a prompt until work start or an explicit correlated terminal native event is observed.

#### Scenario: Prompt is accepted before working status updates
- **WHEN** a prompt is submitted while Herdr still reports the ready idle state
- **THEN** SWF waits for native work-start or terminal evidence and does not complete the invocation prematurely

#### Scenario: Retry follows a low-level completion
- **WHEN** a native harness reports a turn end followed by automatic retry or compaction recovery
- **THEN** SWF keeps the invocation active until the harness reports fully settled completion or terminal failure

#### Scenario: ACP tool finishes before prompt response
- **WHEN** Copilot or OpenCode reports a completed tool call while the correlated ACP prompt remains active
- **THEN** SWF records the tool milestone and keeps the invocation active until terminal prompt evidence arrives

### Requirement: Version-aware native parsers
Each harness adapter SHALL declare the harness version, selected transport, protocol or codec versions, and native event shapes it supports and SHALL fail with actionable compatibility diagnostics when required native records cannot be safely interpreted.

#### Scenario: Unknown required event shape
- **WHEN** an installed harness emits an incompatible terminal event shape
- **THEN** normalization records bounded diagnostic evidence and fails closed rather than guessing that work completed

#### Scenario: Unknown optional event appears
- **WHEN** a harness adds an unrecognized optional event that is not needed for lifecycle correctness
- **THEN** SWF retains it in the raw stream, may record a diagnostic counter, and continues processing supported required events

#### Scenario: Probe and runtime protocol disagree
- **WHEN** a selected Copilot or OpenCode transport initializes with capabilities incompatible with its persisted probe result
- **THEN** SWF fails the invocation before prompt submission and reports both observed descriptors without silently changing transports

## ADDED Requirements

### Requirement: Transport-specific usage provenance
Copilot and OpenCode normalization SHALL report exact or estimated token and cost usage only when attributable structured fields are provided by the selected invocation transport; aggregate statistics and human-readable usage output SHALL remain unknown for invocation accounting.

#### Scenario: OpenCode event includes attributable usage
- **WHEN** a documented OpenCode event provides numeric token or cost fields correlated to the active session and turn
- **THEN** SWF emits usage with the documented quality and source transport

#### Scenario: Copilot provides only textual usage
- **WHEN** Copilot usage is available only through interactive command text or aggregate telemetry
- **THEN** the invocation reports usage quality as unknown rather than parsing the text or treating missing usage as zero

