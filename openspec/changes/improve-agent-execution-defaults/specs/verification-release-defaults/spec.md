## ADDED Requirements

### Requirement: Task-completion verification
Before Verifying can complete, SWF SHALL parse the active OpenSpec task list, require every applicable task to be checked, and require current evidence connecting each completed task to implementation and verification outcomes. A checked box alone SHALL NOT prove correct completion.

#### Scenario: Task remains unchecked
- **WHEN** at least one applicable OpenSpec task remains unchecked
- **THEN** Verifying fails closed with the incomplete task identifiers

#### Scenario: Task evidence is stale
- **WHEN** a task's evidence was produced for a different source commit or normalized input
- **THEN** the task is unverified until current evidence is produced

#### Scenario: Task audit is retained
- **WHEN** Verifying completes
- **THEN** a portable task-audit artifact records every task, mapped implementation references, checks, evidence status, and conclusion

### Requirement: Deterministic verification is primary
The default Verifying phase SHALL run declared deterministic project checks and strict OpenSpec validation before accepting an agent audit. Narrative agent output SHALL NOT override a failed, missing, stale, or unknown required check.

#### Scenario: Test command fails
- **WHEN** a required discovered or configured test command exits nonzero
- **THEN** Verifying fails regardless of the verifier's narrative conclusion

#### Scenario: No required project checks are configured
- **WHEN** a project expects code verification but has not adopted any required project checks
- **THEN** SWF reports the verification gap and follows the configured fail-closed policy rather than treating absence as success

### Requirement: Verification is distinct from review
Reviewing SHALL own general code-quality, correctness, security, regression, and maintainability findings. Verifying SHALL focus on approved task completion, required checks, specification conformance, and evidence validity.

#### Scenario: Workflow reaches Verifying
- **WHEN** Reviewing has completed and Verifying starts
- **THEN** Verifying consumes current review conclusions but does not repeat an unconstrained review prompt

#### Scenario: Review finding remains unresolved
- **WHEN** a required actionable review finding remains unresolved or its remediation evidence is stale
- **THEN** Verifying reports the unresolved dependency and cannot complete

### Requirement: Deterministic Releasing phase
The default Releasing phase SHALL contain no general-purpose agent work. It SHALL deterministically confirm prior gates and evidence, persist the final dossier, perform the configured branch delivery or merge operation, record the delivery result, and clean up only owned runtime resources after successful delivery.

#### Scenario: Local branch is approved for merge
- **WHEN** all prior phases are complete, required release approval is recorded, and local merge is configured
- **THEN** Releasing merges the run branch into the configured target branch using the configured merge method, records the resulting commit, and then cleans up owned run resources

#### Scenario: Pull request delivery is configured
- **WHEN** pull-request delivery is configured and release approval is recorded
- **THEN** Releasing creates or updates the pull request and performs only the merge behavior authorized by delivery policy

#### Scenario: Delivery fails
- **WHEN** branch merge, push, pull-request operation, hosted check, or merge operation fails
- **THEN** Releasing preserves the run branch, worktree, evidence, and owned resources needed for diagnosis and follows configured delivery failure policy

### Requirement: Release authorization
Manual release SHALL require a recorded human approval before merging or otherwise finalizing delivery. Automatic release or merge SHALL require recorded delegated authorization scoped to the project, run, or delivery action. Prior Planning approval SHALL NOT implicitly authorize final merge.

#### Scenario: Manual workflow reaches Releasing
- **WHEN** a manual-policy run completes Verifying
- **THEN** Releasing blocks at a release gate with branch, target, evidence, and merge summary until a human approves

#### Scenario: Autonomous workflow reaches Releasing
- **WHEN** a run has valid delegated authorization covering automatic delivery and all release conditions pass
- **THEN** Releasing may merge automatically and records the authorization used

#### Scenario: Authorization is absent
- **WHEN** automatic merge is requested without sufficient delegated authorization
- **THEN** Releasing blocks without mutating the target branch

### Requirement: Safe release merge
Before merge, SWF SHALL refresh target and source state, verify checkpoint and evidence validity, detect conflicts or target drift, and enforce configured remote, target branch, merge method, protected-branch, and direct-merge policy constraints.

#### Scenario: Target branch has advanced
- **WHEN** the target changes after Verifying
- **THEN** Releasing refreshes merge eligibility and blocks or revalidates according to policy rather than merging against stale assumptions

#### Scenario: Merge conflict exists
- **WHEN** the run branch cannot be merged cleanly
- **THEN** Releasing records the conflict as delivery attention and preserves both branches and the run worktree

### Requirement: Owned cleanup after delivery
Cleanup SHALL occur only after the final dossier and delivery references are durably committed and successful delivery is recorded. SWF SHALL remove only resources in its ownership record and SHALL retain required audit markers.

#### Scenario: Successful merge cleanup
- **WHEN** delivery succeeds and cleanup policy permits removal
- **THEN** SWF closes owned panes, tabs, and workspaces, removes the owned worktree, optionally deletes the delivered source branch as configured, and retains durable run and audit history

#### Scenario: Unowned resource is nearby
- **WHEN** cleanup discovers a Herdr pane, workspace, worktree, or branch absent from the run ownership record
- **THEN** SWF leaves that resource untouched

### Requirement: OpenSpec archive is explicit
Releasing SHALL NOT infer OpenSpec archive from a generic release role. Archive SHALL occur only when the workflow explicitly declares archive after successful verification and at the configured point relative to merge and cleanup.

#### Scenario: Archive is not configured
- **WHEN** Releasing completes and no archive action is declared
- **THEN** the OpenSpec change remains unarchived

#### Scenario: Archive is configured
- **WHEN** an explicit archive action is declared and its prerequisites are satisfied
- **THEN** SWF archives deterministically, records the resulting paths, and includes them in the final dossier and delivery commit
