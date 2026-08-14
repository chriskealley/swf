# phase-agent-contracts Specification

## Purpose
TBD - created by archiving change improve-agent-execution-defaults. Update Purpose after archive.
## Requirements
### Requirement: Structured phase contracts
Each agent phase SHALL resolve a structured contract containing its objective, responsibilities, allowed scope, prohibited actions, required inputs, required outputs, completion criteria, and handoff expectations. Prompt construction SHALL preserve the provenance of built-in, user, project, workflow, phase, and runtime contributions.

#### Scenario: Prompt is constructed
- **WHEN** an agent work unit starts
- **THEN** its prompt contains the resolved phase contract, project guidelines, OpenSpec change context, selected valid prior evidence, runtime boundaries, and explicit completion criteria

#### Scenario: Project extends a contract
- **WHEN** a project adds a Building constraint without replacing the phase objective
- **THEN** prompt resolution includes the constraint and reports its project provenance

### Requirement: Planning contract
The default Planning contract SHALL require a scoped proposal, design decisions and alternatives, testable capability specifications, ordered implementation tasks, risks and unresolved questions, strict OpenSpec validation, deterministic planning evidence, and a downstream handoff. Planning SHALL NOT implement application code or perform delivery.

#### Scenario: Planning completes
- **WHEN** Planning claims completion
- **THEN** all required OpenSpec planning artifacts exist, strict validation passes, evidence and handoff schemas validate, and no application implementation is required for the gate

#### Scenario: Planning drifts into implementation
- **WHEN** Planning modifies application paths outside explicitly permitted planning scope
- **THEN** its completion contract fails or requires explicit operator review according to policy

### Requirement: Building contract
The default Building contract SHALL implement the approved OpenSpec tasks in dependency order, keep task completion truthful, add or update relevant tests, run declared focused checks, record deviations from the design, and produce implementation evidence and a handoff. Building SHALL NOT archive the change, merge branches, or perform release delivery.

#### Scenario: Building marks a task complete
- **WHEN** Building changes an OpenSpec task checkbox to complete
- **THEN** the Building evidence references corresponding implementation changes and relevant test or check evidence

#### Scenario: Building cannot complete a task
- **WHEN** an approved task cannot be implemented within the phase constraints
- **THEN** Building leaves the task incomplete and reports the blocker rather than claiming phase completion

### Requirement: Reviewing contract
The default Reviewing contract SHALL perform independent code review against the proposal, design, specifications, tasks, diff, and tests. It SHALL produce structured findings with severity and evidence, distinguish actionable defects from optional suggestions, and avoid implementing remediation unless a separate remediation action explicitly authorizes mutation.

#### Scenario: Review finds a defect
- **WHEN** Reviewing identifies an implementation defect
- **THEN** it records a structured actionable finding tied to affected paths or artifacts and causes the review gate or remediation policy to prevent unqualified progression

#### Scenario: Review has no findings
- **WHEN** Reviewing finds no actionable defects
- **THEN** it records a structured clean review with the inspected commit and inputs

### Requirement: Verifying contract
The default Verifying contract SHALL audit whether every OpenSpec task is completed correctly using implementation, deterministic check, and evidence references; run the declared verification checks; validate OpenSpec strictly; and report missing, stale, contradictory, or insufficient evidence. Verifying SHALL NOT repeat general code review or introduce unrelated implementation changes.

#### Scenario: Checkbox lacks evidence
- **WHEN** an OpenSpec task is checked but no matching implementation or verification evidence can be established
- **THEN** Verifying reports the task as unverified and the phase cannot satisfy its gate

#### Scenario: All tasks are verified
- **WHEN** every task is checked, mapped to relevant changes, supported by current deterministic evidence, and all required verification checks pass
- **THEN** Verifying records a task-by-task audit and satisfies its completion contract

#### Scenario: General style issue is observed
- **WHEN** Verifying notices a non-blocking style preference unrelated to task completion or failed checks
- **THEN** it does not turn Verifying into a second general code-review pass

### Requirement: Bounded context and evidence selection
Prompt construction SHALL select current, valid, phase-relevant evidence and SHALL avoid including raw transcripts or unbounded repository context by default. Required inputs SHALL identify their source commit or fingerprint.

#### Scenario: Stale handoff exists
- **WHEN** a prior handoff no longer matches the current checkpoint or normalized inputs
- **THEN** it is excluded from authoritative prompt context and the phase is blocked if no valid replacement exists

#### Scenario: Raw transcript exists
- **WHEN** invocation transcripts are retained
- **THEN** the next phase receives compact evidence and handoff conclusions rather than the raw transcript unless explicit authorized inspection is required

### Requirement: Prompt and contract observability
Operators SHALL be able to inspect the resolved phase contract, model tier, concrete model, tools, guidelines, evidence references, and completion criteria before execution without exposing secrets.

#### Scenario: Explain Verifying
- **WHEN** an operator requests a phase explanation
- **THEN** SWF shows that Verifying audits task completion, its selected checks and evidence, its `fast` tier, and its prohibited general review and delivery actions

