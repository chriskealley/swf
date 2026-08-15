# Harness Pane Presentation Specification

## Purpose

Define compact, safe, and consistent human-facing harness output while keeping rendered pane text separate from workflow authority.

## Requirements

### Requirement: Compact human pane output
SWF-owned Herdr harness panes SHALL display compact human-readable execution milestones instead of raw Pi RPC, Claude stream-json, or Codex JSONL objects by default. Presentation SHALL identify phase, harness, model when available, meaningful tool activity, completion or failure, duration, and usage quality.

#### Scenario: Normal Pi execution
- **WHEN** a Pi invocation reads files, writes artifacts, runs validation, and settles
- **THEN** its pane shows bounded readable milestones and a completion summary without displaying protocol JSON, partial message snapshots, or thinking signatures

#### Scenario: Harness fails
- **WHEN** a harness emits a terminal error
- **THEN** the pane shows a concise classified failure and diagnostic reference without dumping the complete native event

### Requirement: Configurable presentation levels
Harness presentation SHALL support `quiet`, `normal`, `verbose`, and `protocol` levels with documented configuration precedence. `normal` SHALL be the generated default. `protocol` SHALL be an explicit diagnostic mode and SHALL warn that output is machine-oriented and may be sensitive even after redaction.

#### Scenario: Quiet presentation
- **WHEN** an invocation uses `quiet`
- **THEN** the pane shows startup, blocked/failure attention, and final completion with duration and usage, but omits routine tool milestones

#### Scenario: Normal presentation
- **WHEN** an invocation uses `normal`
- **THEN** the pane shows phase-level progress and summarized tool milestones without full arguments or output

#### Scenario: Verbose presentation
- **WHEN** an operator explicitly selects `verbose`
- **THEN** the pane may show bounded commands, paths, and truncated tool results while still excluding secrets, raw signatures, and repeated native payloads

#### Scenario: Protocol presentation
- **WHEN** an authorized diagnostic invocation explicitly selects `protocol`
- **THEN** SWF displays the redacted native records while continuing private retention and marks the mode in audit and invocation metadata

### Requirement: Sensitive and bounded rendering
Human presentation SHALL apply redaction before display, omit encrypted thinking signatures and internal protocol blobs at every non-protocol level, truncate unbounded fields, collapse repeated updates, and provide references for explicit inspection of retained details.

#### Scenario: Tool output contains a credential
- **WHEN** a native tool result contains a recognized secret
- **THEN** the pane displays only the redacted bounded summary and the retained raw record is also protected by configured redaction

#### Scenario: Assistant partial grows repeatedly
- **WHEN** a protocol event includes the entire partial assistant message on every text delta
- **THEN** the renderer uses only meaningful deltas or final summaries and does not repeat the accumulated message

### Requirement: Consistent cross-harness vocabulary
Pi, Claude, and Codex panes SHALL use a common milestone vocabulary and visual hierarchy while permitting harness-specific detail where useful.

#### Scenario: Different harnesses run Building
- **WHEN** equivalent Building work runs through Pi, Claude, and Codex
- **THEN** each pane consistently communicates started, working, tool activity, blocked or failed state, and settled completion

### Requirement: Presentation is not workflow authority
Rendered pane text SHALL be a disposable view of normalized events and SHALL NOT be parsed to determine durable workflow state, usage, evidence validity, or settlement. Losing, clearing, truncating, or changing presentation SHALL not affect execution correctness.

#### Scenario: Pane scrollback is truncated
- **WHEN** Herdr discards old visible scrollback
- **THEN** SWF continues parsing the private machine channel and completes the invocation correctly

#### Scenario: Renderer crashes
- **WHEN** compact rendering fails while the harness and machine capture remain active
- **THEN** SWF records presentation degradation, preserves raw processing, and does not claim the invocation failed solely because its optional view failed

### Requirement: Useful live status
Pane titles and compact output SHALL identify the run or change, phase, harness, and current normalized status so operators can distinguish multiple owned invocations without inspecting environment variables or raw JSON.

#### Scenario: Multiple phases are visible
- **WHEN** an operator lists Herdr panes from multiple runs
- **THEN** SWF-owned pane labels and recent output make each change, phase, harness, and status distinguishable
