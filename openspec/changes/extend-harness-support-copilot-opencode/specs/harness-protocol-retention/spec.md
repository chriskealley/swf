## MODIFIED Requirements

### Requirement: Separate machine and presentation channels
SWF SHALL capture native Pi RPC, Claude stream-json, Codex JSONL, Copilot ACP/JSONL, and OpenCode ACP/JSON protocols independently from the Herdr pane's human presentation. Structured adapters SHALL consume the captured native or normalized channel and SHALL NOT rely on scraping human-visible pane transcripts for protocol parsing.

#### Scenario: Pane shows compact output
- **WHEN** a renderer replaces raw terminal protocol output with compact milestones
- **THEN** the adapter still receives every required native event through the separate machine channel

#### Scenario: Operator writes to the pane
- **WHEN** unrelated terminal text appears in pane scrollback
- **THEN** it cannot be mistaken for a native harness protocol event

#### Scenario: Legacy Copilot fallback is selected
- **WHEN** an installed Copilot version exposes no supported structured transport and the phase permits legacy operation
- **THEN** SWF explicitly records that no private machine protocol is available and does not claim structured capture or adoption

### Requirement: Bidirectional harness bridge
For interactive machine protocols including Pi RPC and ACP, the bridge SHALL preserve framed command input, native stdout and stderr capture, request correlation, session creation or loading, blocked-input and permission responses, follow-ups, cancellation, process exit, and signal forwarding. For one-shot streaming harnesses, it SHALL preserve process lifecycle and resume/session references.

#### Scenario: Pi receives a prompt
- **WHEN** SWF submits a JSON RPC prompt through the bridge
- **THEN** Pi receives exactly one LF-framed command and its correlated response and events are captured without being dumped raw to the pane

#### Scenario: ACP harness receives a prompt
- **WHEN** SWF submits work to a negotiated Copilot or OpenCode ACP server
- **THEN** the bridge initializes the protocol, creates or loads the session, sends one correlated prompt request, and captures both protocol directions privately

#### Scenario: Cancellation is requested
- **WHEN** SWF cancels an owned invocation
- **THEN** the bridge sends the harness-native cancellation or signal, records the resulting native events, and emits normalized cancellation state

### Requirement: Protocol-compliant framing
Capture SHALL respect each harness's framing rules, including Pi's strict LF-delimited JSON semantics and ACP's protocol-only newline-delimited JSON channel, without using line readers that reinterpret valid Unicode separators. Partial records SHALL be buffered until complete, and an interrupted trailing partial record SHALL not be interpreted as a complete event.

#### Scenario: Pi payload contains Unicode separators
- **WHEN** a valid Pi JSON string contains U+2028 or U+2029
- **THEN** the bridge retains it within one LF-framed record

#### Scenario: ACP record arrives partially
- **WHEN** an ACP JSON record is split across stdout chunks
- **THEN** the bridge buffers the bytes until the newline delimiter and retains one complete native record

#### Scenario: Process exits mid-record
- **WHEN** a harness terminates with an incomplete trailing native record
- **THEN** SWF retains bounded diagnostic bytes and does not normalize the partial record as valid completion

## ADDED Requirements

### Requirement: Version-gated transport fallback
SWF SHALL select Copilot and OpenCode transports using a documented preference order and persisted compatibility probe, SHALL NOT switch transport during an invocation, and SHALL expose the capability degradation of any selected fallback.

#### Scenario: OpenCode ACP is unavailable
- **WHEN** the installed OpenCode version lacks compatible ACP but supports documented JSON events satisfying the phase contract
- **THEN** SWF launches the versioned JSON-events codec and records that transport before prompt submission

#### Scenario: Copilot structured transport is unavailable
- **WHEN** the installed Copilot version lacks compatible ACP and JSONL support but the phase permits transcript operation
- **THEN** SWF uses the legacy adapter with structured events, durable settlement, restart adoption, blocked input, and usage marked unsupported

#### Scenario: Required structured transport is unavailable
- **WHEN** no probed transport satisfies the phase's required capabilities
- **THEN** SWF fails before creating execution resources and reports the supported upgrade or configuration options

