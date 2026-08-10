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

### Requirement: GitHub delivery preflight
Before expensive execution of a workflow requiring pull-request delivery, the system SHALL verify a configurable Git remote defaulting to `origin`, a GitHub repository URL, network access, a resolvable target branch, valid `gh` authentication, push permission, pull-request creation permission, and merge or auto-merge permission required by resolved policy.

#### Scenario: Required Git remote is missing
- **WHEN** the default workflow requires pull-request delivery but its configured remote does not exist
- **THEN** preflight fails before agent execution and explains how to configure the remote or select local-branch delivery

#### Scenario: GitHub authentication is invalid
- **WHEN** `gh` is installed but cannot authenticate to the configured repository
- **THEN** preflight fails without starting the workflow and directs the user to the appropriate GitHub CLI authentication flow

#### Scenario: Local-branch delivery is configured
- **WHEN** a workflow explicitly selects local-branch delivery
- **THEN** GitHub remote, `gh` authentication, pull-request permission, and merge permission checks are not required for that run

### Requirement: GitHub pull-request-first delivery
The initial Git hosting integration SHALL use required GitHub CLI (`gh`) behind a hosting-adapter boundary, and the default final delivery mode SHALL create or update a GitHub pull request from the run branch to the configured target branch after final checks pass.

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

### Requirement: Configurable pull-request merge method
When pull-request merging is authorized, the system SHALL use a merge commit by default and SHALL allow project configuration to select squash, rebase, or repository-default behavior when supported by GitHub and repository policy.

#### Scenario: Merge method is not configured
- **WHEN** approval policy authorizes merging and the project has not selected a merge method
- **THEN** the system requests a merge commit after required hosted checks pass

#### Scenario: Project selects squash
- **WHEN** approval policy authorizes merging and project configuration selects squash
- **THEN** the system requests a squash merge or reports that repository policy does not support it

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
