## ADDED Requirements

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
The system SHALL persist a compact dossier with the OpenSpec change containing phase handoffs, evidence manifest, approvals, checkpoints, delivery references, and final report while excluding secrets and large raw operational output.

#### Scenario: Inspect a cloned archived change
- **WHEN** a user inspects a repository clone without the original `.swf-state/`
- **THEN** the committed change dossier retains the important execution conclusions and references, while clearly indicating that raw local history is unavailable

### Requirement: Operational history isolation
The system SHALL keep full events, raw transcripts, command logs, snapshots, and large artifacts under Git-ignored root-level `.swf-state/`.

#### Scenario: Record large agent output
- **WHEN** a harness invocation produces large output
- **THEN** the full output is retained in `.swf-state/` and only a bounded summary or reference is placed in committed evidence
