## ADDED Requirements

### Requirement: Durable read-only exploration
The system SHALL support durable pre-change explorations under `.swf-state/explorations/<exploration-id>/` containing metadata, append-only events, retained transcript, and a distilled planning brief without creating an OpenSpec change or SWF run.

#### Scenario: Explore an idea
- **WHEN** a user starts `swf explore` with an idea
- **THEN** the exploration may inspect and research the project in read-only mode, ask questions, and persist its history without modifying application code or producing the formal OpenSpec proposal

#### Scenario: Distill an exploration
- **WHEN** an exploration reaches a useful stopping point
- **THEN** the system records a brief containing problem, goals, non-goals, options, decisions, open questions, codebase findings, candidate scope, and candidate change name

### Requirement: Explicit exploration promotion
The system SHALL require an explicit exploration identity when using an exploration as the foundation for `swf new` or `swf run`, and SHALL preserve that identity and normalized brief as Planning input.

#### Scenario: Promote an exploration into Planning
- **WHEN** a user invokes new or run with `--from-exploration <id>`
- **THEN** the selected brief is copied into normalized Planning input and the resulting run references the exploration

#### Scenario: Multiple explorations exist
- **WHEN** a client has more than one recent exploration and the user starts work without selecting one
- **THEN** the system does not silently choose the latest exploration

#### Scenario: Discard an exploration
- **WHEN** a user discards an exploration
- **THEN** the system marks it discarded for later retention pruning rather than immediately deleting its audit history

### Requirement: Typed artifact catalog
The system SHALL catalog phase outputs as typed artifacts with producer, phase attempt, timestamps, status, source commit, normalized input fingerprint, output references, and consumer records.

#### Scenario: Record unit-test evidence
- **WHEN** a unit-test command completes
- **THEN** the system creates a test-result artifact containing command identity, source commit, exit status, summary, and raw output reference

#### Scenario: Consume prior evidence
- **WHEN** a later phase receives a prior artifact
- **THEN** the system records that consumption without changing the artifact's original producer or facts

### Requirement: Validity-bound artifact reuse
The system SHALL reuse an artifact to satisfy work or a check only when its validity rules match the current inputs; initial command reuse MUST require the exact source commit and normalized command/configuration fingerprint.

#### Scenario: Reuse unchanged test result
- **WHEN** a later phase requests the same test command against the exact producing commit and configuration
- **THEN** the system may reuse the valid artifact and records that the operation was not repeated

#### Scenario: Source changes after test
- **WHEN** the source commit changes after a test artifact was produced
- **THEN** the system marks the artifact stale for gate satisfaction and reruns the required check

### Requirement: Deterministic phase evidence
Before finalizing a phase, the system SHALL collect declared deterministic facts including Git state, commit range, changed files, command results, check results, and relevant OpenSpec status.

#### Scenario: Agent claims tests passed without evidence
- **WHEN** an agent narrative says tests passed but no valid deterministic test-result artifact exists
- **THEN** the claim does not satisfy a required test check

### Requirement: Same-agent structured handoff
After collecting deterministic facts, the system SHALL request a schema-valid handoff from the same contextual phase agent containing summary, decisions, known issues, recommended next actions, and references to existing artifacts.

#### Scenario: Phase agent produces handoff
- **WHEN** phase work and deterministic collection complete successfully
- **THEN** the system sends the canonical facts to the same agent, validates its handoff, and stores narrative separately from deterministic facts

#### Scenario: Phase agent cannot produce handoff
- **WHEN** the original agent is unavailable or repeatedly returns an invalid handoff
- **THEN** the system preserves a deterministic degraded handoff and applies configured retry or fallback policy without losing phase evidence

### Requirement: Selective downstream context
The system SHALL construct each phase's context from declared OpenSpec artifacts, valid evidence summaries, and phase handoffs, with references to raw outputs rather than injecting all transcripts by default.

#### Scenario: Reviewer receives implementation context
- **WHEN** the review phase starts
- **THEN** it receives configured specifications, implementation handoff, changed-files and diff evidence, and valid check summaries while raw logs remain addressable by reference

### Requirement: Portable change dossier
The system SHALL persist a compact dossier at `openspec/changes/<change>/evidence/` containing phase handoffs, evidence manifest, approvals, checkpoints, delivery references, and final report while excluding secrets and large raw operational output.

#### Scenario: Archive an OpenSpec change
- **WHEN** OpenSpec archives a completed change
- **THEN** the entire `evidence/` subtree moves with the change to `openspec/changes/archive/<date>-<change>/evidence/`

#### Scenario: Inspect a cloned archived change
- **WHEN** a user inspects a repository clone without the original `.swf-state/`
- **THEN** the committed change dossier retains the important execution conclusions and references, while clearly indicating that raw local history is unavailable

### Requirement: Operational history isolation
The system SHALL keep full events, raw transcripts, command logs, snapshots, and large artifacts under Git-ignored root-level `.swf-state/`.

#### Scenario: Record large agent output
- **WHEN** a harness invocation produces large output
- **THEN** the full output is retained in `.swf-state/` and only a bounded summary or reference is placed in committed evidence

### Requirement: User-controlled raw-output pruning
The system SHALL provide a simple user-controlled mechanism to preview and prune eligible raw invocation outputs by age, selected run, or storage budget while retaining durable events, metadata, costs, summaries, manifests, approvals, checkpoints, and committed evidence.

#### Scenario: Preview pruning
- **WHEN** a user requests a pruning dry run with an age or storage constraint
- **THEN** the system reports which raw outputs and bytes would be removed without changing stored data

#### Scenario: Prune old raw output
- **WHEN** an authorized user confirms pruning
- **THEN** eligible raw payloads are removed, their references remain marked as pruned by retention policy, and compact audit and evidence records remain available
