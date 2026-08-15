## MODIFIED Requirements

### Requirement: Compact human pane output
SWF-owned Herdr harness panes SHALL display compact human-readable execution milestones instead of raw Pi RPC, Claude stream-json, Codex JSONL, Copilot ACP/JSONL, or OpenCode ACP/JSON event objects by default. Presentation SHALL identify phase, harness, negotiated transport, model when available, meaningful tool activity, completion or failure, duration, and usage quality.

#### Scenario: Normal Pi execution
- **WHEN** a Pi invocation reads files, writes artifacts, runs validation, and settles
- **THEN** its pane shows bounded readable milestones and a completion summary without displaying protocol JSON, partial message snapshots, or thinking signatures

#### Scenario: Normal OpenCode execution
- **WHEN** an OpenCode invocation runs through ACP or JSON events and settles
- **THEN** its pane uses the common compact milestones and identifies OpenCode without exposing ACP frames or native event objects

#### Scenario: Harness fails
- **WHEN** a harness emits a terminal error
- **THEN** the pane shows a concise classified failure and diagnostic reference without dumping the complete native event

### Requirement: Consistent cross-harness vocabulary
Pi, Claude, Codex, Copilot, and OpenCode panes SHALL use a common milestone vocabulary and visual hierarchy while permitting harness- and transport-specific detail where useful.

#### Scenario: Different harnesses run Building
- **WHEN** equivalent Building work runs through any supported structured harness
- **THEN** each pane consistently communicates started, working, tool activity, blocked or failed state, and settled completion

#### Scenario: Copilot uses legacy fallback
- **WHEN** an older Copilot installation runs through the transcript fallback
- **THEN** the pane identifies the degraded transport and does not display structured settlement, recovery, or usage claims

