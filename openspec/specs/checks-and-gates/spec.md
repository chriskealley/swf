# checks-and-gates Specification

## Purpose

Define typed verification checks, transition gates, approvals, overrides, retries, and remediation behavior.

## Requirements

### Requirement: Typed checks produce evidence
The system SHALL support command, agentic, OpenSpec, and human checks, and every completed check SHALL produce a typed result and evidence record.

#### Scenario: Command check passes
- **WHEN** a required command exits successfully under its configured acceptance rules
- **THEN** the system records a passed check linked to its command-result artifact

#### Scenario: Agentic review finds blockers
- **WHEN** an agentic check returns schema-valid blocking findings
- **THEN** the system records the findings and treats the check as failed or remediation-required according to policy

#### Scenario: OpenSpec validation fails
- **WHEN** a required OpenSpec validation reports an error
- **THEN** the phase gate cannot pass until the validation is corrected or explicitly waived by an authorized policy

### Requirement: Manual check refresh
The system SHALL allow an authorized user to run an individual declared check to produce fresh evidence without representing the containing phase as completed.

#### Scenario: Rerun unit tests only
- **WHEN** a user invokes `swf check run <change> <check-id>` for the declared unit-test check
- **THEN** the system records a new check attempt and evidence artifact but leaves phase completion to normal gate and phase evaluation

### Requirement: Gates control transitions
A phase SHALL advance only when its transition gate evaluates the required valid check evidence as passing under the resolved policy.

#### Scenario: All required checks pass
- **WHEN** a gate requiring all checks evaluates valid passed evidence for each required check
- **THEN** the system records the gate decision and permits the next phase

#### Scenario: Required evidence is stale
- **WHEN** a required check references stale evidence
- **THEN** the gate remains unsatisfied and requires fresh evidence

### Requirement: Manual approval
The system SHALL support gates that wait for a specific recorded human approval, rejection, or request for changes.

#### Scenario: Human approves a gate
- **WHEN** an authorized operator reviews the displayed implications and approves
- **THEN** the system records the actor, decision, time, scope, and relevant evidence before reevaluating the gate

#### Scenario: Human requests changes
- **WHEN** an operator requests changes with feedback
- **THEN** the system records the feedback and routes the run to configured remediation without representing the gate as approved

### Requirement: Delegated automatic approval
Policy SHALL be able to satisfy an approval requirement automatically only when a human has explicitly authorized autonomous operation for a recorded scope.

#### Scenario: Run-scoped autonomous authorization
- **WHEN** a human launches a run after acknowledging its resolved autonomous implications
- **THEN** qualifying approvals may be recorded as policy auto-approvals linked to that human authorization

#### Scenario: Record an auto-approval accurately
- **WHEN** policy auto-satisfies a human approval requirement
- **THEN** the recorded actor is policy, the decision is `auto-approved`, and the event identifies the authorizing human, authorization scope, source configuration, and reason

### Requirement: Risk and fail-closed overrides
The system SHALL allow policy to require manual intervention for configured risk conditions regardless of general autonomous mode and SHALL fail closed when required authorization is missing or indeterminate.

#### Scenario: Sensitive path changed
- **WHEN** autonomous mode is active but the diff matches a configured sensitive path rule
- **THEN** the gate waits for manual approval and explains the overriding risk rule

#### Scenario: Required approver is unavailable
- **WHEN** a non-delegable human approval is required and no authorized operator responds
- **THEN** the system remains blocked or times out according to policy and does not advance automatically

### Requirement: Bounded retries and remediation
The system SHALL bound retry and remediation loops by configured attempt, time, and cost limits and SHALL escalate or stop when a bound is reached.

#### Scenario: Reviewer repeatedly finds the same blocker
- **WHEN** remediation reaches its configured attempt limit
- **THEN** the system stops automatic looping, preserves all attempts, and requests escalation or terminates according to policy
