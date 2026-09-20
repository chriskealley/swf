# Spec Delta

## Purpose

Define optional, recoverable intake from an OpenRoad roadmap into an OpenSpec change and its single SWF execution run.

## ADDED Requirements

### Requirement: OpenRoad-authoritative selection
When roadmap intake is requested for a project with a valid OpenRoad roadmap, the system SHALL use the versioned OpenRoad 0.2.0 machine-readable selection operation and SHALL select exactly the item it returns. SWF SHALL NOT independently rank, skip, or manufacture roadmap work.

#### Scenario: Highest-priority eligible item is selected
- **WHEN** an operator requests roadmap intake and OpenRoad returns an eligible ready item
- **THEN** the system uses that item as the sole source for the new change scope

#### Scenario: Other work is active
- **WHEN** OpenRoad returns an eligible item while another roadmap item is active, blocked, or paused
- **THEN** the system starts the returned item without treating unrelated active work as a conflict

#### Scenario: No work is eligible
- **WHEN** OpenRoad reports that no roadmap item is eligible
- **THEN** the system creates no OpenSpec change or SWF run and returns OpenRoad's machine-readable diagnostics

### Requirement: Atomic-intent roadmap startup
The system SHALL establish one stable roadmap item, OpenSpec change, and SWF run association before Planning execution, and SHALL use idempotent OpenRoad linkage so a repeated request converges on the same association.

#### Scenario: New roadmap item starts successfully
- **WHEN** the selected item has no prior change or run association
- **THEN** the system creates the derived OpenSpec change, creates its single SWF run, records the roadmap provenance, activates the item through OpenRoad, and starts Planning

#### Scenario: Intake is repeated
- **WHEN** roadmap intake is repeated after the item, change, and run association has been recorded
- **THEN** the system returns or resumes the existing run without creating another item link, change, or run

### Requirement: Partial-start recovery
Before selecting additional work, the system SHALL reconcile recoverable roadmap intake intents and SHALL either complete the missing association step or report an explicit conflict without replacing either identity.

#### Scenario: Roadmap link exists without a run
- **WHEN** an item is active and linked to the intended OpenSpec change but no SWF run is bound to that change
- **THEN** the system creates and binds the missing run and starts or resumes Planning for that same item and change

#### Scenario: Run exists without roadmap activation
- **WHEN** the intended OpenSpec change and SWF run exist with matching roadmap provenance but the roadmap item is not linked and active
- **THEN** the system idempotently links that change through OpenRoad and resumes the existing run

#### Scenario: Identities conflict
- **WHEN** a roadmap item, OpenSpec change, or SWF run is already associated with a different counterpart
- **THEN** the system performs no reassignment or new selection and reports the conflicting identities and recovery guidance

### Requirement: Optional intake boundary
Roadmap intake SHALL be opt-in and SHALL leave direct OpenSpec change entry behavior available when no valid roadmap is present or the operator chooses direct entry.

#### Scenario: Direct entry is used
- **WHEN** an operator invokes an existing direct SWF entry command with an explicit change identity
- **THEN** the system follows the existing direct startup behavior without requiring or mutating an OpenRoad roadmap

#### Scenario: Roadmap is invalid
- **WHEN** roadmap intake is explicitly requested but OpenRoad validation fails
- **THEN** the system creates no change or run and returns actionable validation diagnostics

