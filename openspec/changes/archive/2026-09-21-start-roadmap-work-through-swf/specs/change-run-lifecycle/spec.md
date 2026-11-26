# Spec Delta

## ADDED Requirements

### Requirement: Durable roadmap provenance
For a run created through roadmap intake, the system SHALL durably record the roadmap item ID, OpenSpec change name, and intake operation identity with the run before Planning begins, while preserving the existing one-change-to-one-run constraint.

#### Scenario: Inspect a roadmap-originated run
- **WHEN** an operator or recovery process loads a run created through roadmap intake
- **THEN** it can determine the exact roadmap item and OpenSpec change associated with that run from durable state

#### Scenario: Load a direct-entry run
- **WHEN** an existing run or a new direct-entry run has no roadmap provenance
- **THEN** the system loads and executes it without fabricating a roadmap association

### Requirement: Roadmap-aware service recovery
Service startup and explicit reconciliation SHALL inspect incomplete roadmap intake records before beginning new roadmap selection and SHALL preserve OpenRoad lifecycle authority while restoring the corresponding SWF run association.

#### Scenario: Service restarts during intake
- **WHEN** the service restarts after at least one durable intake association step but before Planning starts
- **THEN** it resumes reconciliation from durable identities and does not create a second change or run

#### Scenario: Recovery cannot prove identity
- **WHEN** durable state is insufficient to prove that an item, change, and run belong together
- **THEN** the system blocks automatic recovery and reports the observed identities without mutating their associations

