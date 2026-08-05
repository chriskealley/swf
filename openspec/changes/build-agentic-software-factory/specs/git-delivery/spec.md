## ADDED Requirements

### Requirement: Phase checkpoints
After a phase gate passes, the system SHALL record a Git checkpoint containing before and after commits, changed-file evidence, artifact manifest, handoff, gate decision, and clean-tree status.

#### Scenario: Phase changes tracked files
- **WHEN** a successful phase leaves valid tracked changes
- **THEN** the system commits those changes on the run branch and records the resulting commit as the checkpoint

#### Scenario: Phase makes no tracked changes
- **WHEN** a successful phase has no tracked changes
- **THEN** the system records a logical checkpoint at the current commit without requiring an empty commit

### Requirement: Rollback to checkpoint
The system SHALL support rollback of the isolated run worktree to a prior phase checkpoint and SHALL invalidate later dependent phase outcomes and artifacts.

#### Scenario: Roll back after failed review
- **WHEN** an authorized operator or policy rolls back to the implementation checkpoint
- **THEN** the run branch and worktree return to that checkpoint, later artifacts become invalid for gate satisfaction, and all rollback actions are appended to history

### Requirement: Pull-request-first delivery
The default final delivery mode SHALL create or update a pull request from the run branch to the configured target branch after final checks pass.

#### Scenario: Manual policy completes execution
- **WHEN** final checks pass under manual approval policy
- **THEN** the system opens or updates a pull request, records it as an artifact, and reports execution complete with delivery awaiting merge

#### Scenario: Existing run pull request
- **WHEN** delivery is retried and a pull request already exists for the run
- **THEN** the system updates or reuses that pull request instead of creating an unintended duplicate

### Requirement: Approval-aware merge behavior
The system SHALL await manual merge under manual approval policy and SHALL request or perform repository-supported auto-merge when delegated automatic policy authorizes delivery.

#### Scenario: Autonomous delivery
- **WHEN** final checks pass, autonomous delivery is authorized, and pull-request auto-merge is supported
- **THEN** the system requests auto-merge and continues monitoring required repository checks

#### Scenario: Automatic merge is not authorized
- **WHEN** general execution is complete but merge approval remains manual
- **THEN** the system leaves the pull request open and does not merge directly

### Requirement: Explicit alternative delivery modes
Local-branch-only and direct-merge delivery SHALL require explicit project workflow configuration and SHALL be displayed in resolved run implications before execution.

#### Scenario: Direct merge configured
- **WHEN** a trusted project explicitly configures direct merge and the resolved approval policy authorizes it
- **THEN** the system performs the merge only after all final gates pass and records the result

### Requirement: Separate execution and delivery status
The system SHALL track workflow execution status separately from pull-request and merge delivery status.

#### Scenario: Pull request awaits review
- **WHEN** all workflow phases complete and the pull request remains open
- **THEN** the run reports execution as completed and delivery as awaiting merge

### Requirement: Delivery monitoring
The persistent service SHALL observe pull-request checks, review state, merge state, closure, and configured branch cleanup after agent execution finishes.

#### Scenario: Hosted CI fails after PR creation
- **WHEN** a required hosted check fails
- **THEN** the system records the failure, updates delivery status, and applies configured remediation or escalation policy
