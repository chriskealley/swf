## ADDED Requirements

### Requirement: Separate machine and presentation channels
SWF SHALL capture the native machine protocol independently from the Herdr pane's human presentation. Adapters SHALL consume the captured native or normalized channel and SHALL NOT rely on scraping human-visible pane transcripts for protocol parsing.

#### Scenario: Pane shows compact output
- **WHEN** a renderer replaces raw terminal JSON with compact milestones
- **THEN** the adapter still receives every required native event through the separate machine channel

#### Scenario: Operator writes to the pane
- **WHEN** unrelated terminal text appears in pane scrollback
- **THEN** it cannot be mistaken for a native harness protocol event

### Requirement: Bidirectional harness bridge
For interactive machine protocols, the bridge SHALL preserve framed command input, native stdout and stderr capture, prompt correlation, blocked-input responses, follow-ups, cancellation, process exit, and signal forwarding. For one-shot streaming harnesses, it SHALL preserve process lifecycle and resume/session references.

#### Scenario: Pi receives a prompt
- **WHEN** SWF submits a JSON RPC prompt through the bridge
- **THEN** Pi receives exactly one LF-framed command and its correlated response and events are captured without being dumped raw to the pane

#### Scenario: Cancellation is requested
- **WHEN** SWF cancels an owned invocation
- **THEN** the bridge sends the harness-native cancellation or signal, records the resulting native events, and emits normalized cancellation state

### Requirement: Protocol-compliant framing
Capture SHALL respect each harness's framing rules, including Pi's strict LF-delimited JSON semantics, without using line readers that reinterpret valid Unicode separators. Partial records SHALL be buffered until complete, and an interrupted trailing partial record SHALL not be interpreted as a complete event.

#### Scenario: Pi payload contains Unicode separators
- **WHEN** a valid Pi JSON string contains U+2028 or U+2029
- **THEN** the bridge retains it within one LF-framed record

#### Scenario: Process exits mid-record
- **WHEN** a harness terminates with an incomplete trailing native record
- **THEN** SWF retains bounded diagnostic bytes and does not normalize the partial record as valid completion

### Requirement: Private redacted raw retention
Complete native records needed for audit and recovery SHALL be retained under the run's private state with mode `0600`, configured redaction, invocation and protocol metadata, and bounded indexing. Raw streams SHALL not be committed or included in portable dossiers.

#### Scenario: Raw event stream is created
- **WHEN** an invocation starts
- **THEN** its native stream and index are created below `.swf-state/runs/<run-id>/raw/` with private permissions and ownership metadata

#### Scenario: Dossier is generated
- **WHEN** a run dossier is persisted
- **THEN** it contains compact invocation conclusions, normalized usage, and references but excludes native protocol records and raw thinking data

### Requirement: Incremental durable cursors
SWF SHALL maintain sufficient cursors or indexes to resume native event parsing after service restart without replaying normalized milestones or rereading an unbounded stream. Cursor state SHALL be rebuildable from retained records and durable normalized event identities.

#### Scenario: Service restarts during execution
- **WHEN** the service restarts while an owned harness process remains observable
- **THEN** it resumes capture or reconciliation from the last durable cursor and avoids duplicate invocation events

#### Scenario: Cursor metadata is missing
- **WHEN** cursor metadata is unavailable but retained records remain valid
- **THEN** SWF rebuilds the cursor and normalization position from framed records and durable event identities

### Requirement: Explicit raw inspection
Authorized clients SHALL be able to inspect retained native output by invocation and bounded range with redaction and truncation. Routine status, progress, approval, and dossier views SHALL use normalized summaries instead.

#### Scenario: Operator diagnoses a parser failure
- **WHEN** an authorized operator requests native records around a failed event cursor
- **THEN** SWF returns a bounded redacted slice and protocol metadata without exposing unrelated invocation streams

### Requirement: Retention and pruning integration
Native protocol files SHALL participate in existing preview-and-confirm raw-output retention. Pruning SHALL preserve normalized events, invocation metadata, usage, summaries, cursor-safe terminal markers, and audit records that raw data is unavailable.

#### Scenario: Raw protocol is pruned
- **WHEN** an operator confirms eligible retention pruning
- **THEN** native protocol files are removed, normalized history remains usable, and inspection reports that raw protocol is unavailable

### Requirement: Bridge ownership and cleanup
Bridge processes, files, pipes, and related Herdr resources SHALL be recorded as SWF-owned resources. Cleanup SHALL affect only recorded resources and SHALL preserve diagnostic data on nonterminal or failed invocations according to retention policy.

#### Scenario: Successful terminal invocation is cleaned
- **WHEN** workflow cleanup is authorized after durable settlement
- **THEN** SWF terminates any remaining owned bridge process and removes ephemeral pipes while retaining configured raw protocol evidence

#### Scenario: Unowned process is present
- **WHEN** another process exists in the same workspace but is absent from invocation ownership
- **THEN** bridge cleanup leaves it untouched
