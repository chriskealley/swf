# Spec Delta

## ADDED Requirements

### Requirement: Roadmap workflow entry
The shared service API and CLI SHALL expose an explicit roadmap entry operation that selects eligible work through OpenRoad and starts Planning using the same service-owned scheduling path as direct workflow entry.

#### Scenario: Start the next roadmap item and stop after Planning
- **WHEN** an operator requests single-phase roadmap entry
- **THEN** the service selects and associates the eligible roadmap item, executes Planning, and stops after that phase completes

#### Scenario: Start automatic roadmap execution
- **WHEN** an operator requests automatic roadmap entry
- **THEN** the service selects and associates the eligible roadmap item, executes Planning, and continues through eligible phases according to existing run policy

### Requirement: Machine-readable intake outcomes
Roadmap entry SHALL return stable machine-readable results for successful selection, idempotent resume, no eligible work, invalid roadmap, recovered partial startup, and conflicting association, including the roadmap item ID, change name, and run ID whenever known.

#### Scenario: Automation receives a successful selection
- **WHEN** automation requests roadmap entry with JSON output
- **THEN** it receives the selected roadmap item ID, linked change name, run ID, current phase or stopping reason, and whether recovery or idempotent reuse occurred

#### Scenario: Automation receives a conflict
- **WHEN** roadmap intake detects incompatible existing associations
- **THEN** JSON output identifies each known item, change, and run identity and provides a non-success classification without interactive output

