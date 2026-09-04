# operator-guidance Specification

## Purpose
Define the durable service projection and semantic guidance that keep operators
oriented and constrain every suggested action to the current workflow state.

## Requirements
### Requirement: Service-owned operator projection
The service SHALL derive an operator-facing projection from durable run state, resolved workflow configuration, approvals, checks, artifacts, checkpoints, delivery state, and active invocations. The projection SHALL identify what most recently happened, the current workflow state, any item requiring operator attention, the actions currently permitted, and one recommended next action when progression is possible.

#### Scenario: Paused run has a next phase
- **WHEN** a run is paused after completing a phase and another phase is eligible
- **THEN** the projection identifies the completed phase, the next eligible phase, and semantic actions for executing one phase or continuing automatic progression

#### Scenario: Completed run has delivery guidance
- **WHEN** execution and local-branch delivery are complete
- **THEN** the projection identifies the delivery branch, target branch, dossier, checkpoint summary, and semantic review and merge actions

#### Scenario: Projection is rebuilt
- **WHEN** snapshots or cached projections are absent
- **THEN** the service reconstructs the same operator projection from durable authoritative state

### Requirement: Explicit attention items
The service SHALL represent approval requirements, blocked agent input, failed checks, budget blocks, delivery failures, unavailable dependencies, and recoverable infrastructure failures as typed attention items rather than requiring clients to infer meaning from a generic run status.

#### Scenario: Manual gate requires approval
- **WHEN** a phase reaches a manual gate with valid evidence
- **THEN** the attention item identifies the run, change, phase, gate, reason, evidence summary, relevant risks, and allowed approve, request-changes, and reject actions

#### Scenario: Agent requires input
- **WHEN** an owned invocation reports blocked input
- **THEN** the attention item identifies the invocation, prompt, phase, and semantic action for replying to that exact invocation

#### Scenario: No attention is required
- **WHEN** a run is paused only because the operator requested one-phase progression
- **THEN** the projection distinguishes normal pause from an attention-requiring block

### Requirement: Semantic next actions
Operator projections and mutating command responses SHALL expose next actions as typed data with action identifiers and required parameters. Semantic actions SHALL not embed client-specific command strings as their source of truth.

#### Scenario: Approval action parameters
- **WHEN** Planning is awaiting approval
- **THEN** the approve action contains the project, run, phase, and gate references required to execute the decision

#### Scenario: Client renders a command
- **WHEN** the CLI receives a semantic approve action
- **THEN** it can render an executable CLI command without independently reconstructing workflow state

#### Scenario: Action is no longer valid
- **WHEN** state changes before a client submits a previously advertised action
- **THEN** the service rejects the stale action and returns the current attention and next-action projection

### Requirement: Evidence-oriented approval guidance
Approval guidance SHALL provide a compact review surface without exposing raw transcripts by default. It SHALL include deterministic check outcomes, changed-file or artifact summaries, handoff conclusions, known risks, and references that clients can inspect.

#### Scenario: Planning approval review
- **WHEN** Planning reaches its manual gate
- **THEN** the projection summarizes OpenSpec validation, produced planning artifacts, changed paths, handoff risks, and references to retained evidence

#### Scenario: Raw output is retained
- **WHEN** approval guidance references an agent invocation
- **THEN** the default guidance excludes raw transcript content while permitting an authorized explicit inspection action

### Requirement: Consistent client interpretation
CLI, Pi, and dashboard clients SHALL consume the same service-owned attention and next-action semantics. Clients MAY render differently for their medium but MUST NOT derive contradictory workflow guidance from raw statuses.

#### Scenario: Approval shown in multiple clients
- **WHEN** a run is blocked at a manual gate
- **THEN** CLI, Pi, and dashboard identify the same phase, gate, allowed decisions, and recommended action

#### Scenario: Incorrect response phase is prevented
- **WHEN** automatic progression selects multiple phases but stops at the first blocked phase
- **THEN** the operator projection and command response identify the phase where progression actually stopped rather than the final phase in the selection

### Requirement: Failure and recovery guidance
Failures SHALL be classified as configuration, dependency, infrastructure, harness, work, check, policy, budget, or delivery failures when sufficient evidence exists. The projection SHALL distinguish retryable failures from failures requiring configuration or human remediation.

#### Scenario: Retryable infrastructure failure
- **WHEN** a harness control command fails before agent work starts
- **THEN** guidance identifies the failure as infrastructure-related, reports durable run condition, and offers a safe resume or reconciliation action when permitted

#### Scenario: Work product validation fails
- **WHEN** an agent completes but required artifacts or checks fail
- **THEN** guidance lists the failed validations and recommends retry, request-changes, or inspection according to policy
