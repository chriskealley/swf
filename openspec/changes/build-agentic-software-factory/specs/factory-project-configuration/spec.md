## ADDED Requirements

### Requirement: Project initialization
The system SHALL initialize a project with version-controlled factory defaults under `.swf/` and SHALL add root-level `.swf-state/` to the project's Git ignore rules.

#### Scenario: Initialize an unconfigured project
- **WHEN** a user initializes SWF in a trusted project that has no `.swf/` configuration
- **THEN** the system creates default configuration, workflows, guidelines, agent profiles, and policies under `.swf/` and prepares an ignored `.swf-state/` operational directory

#### Scenario: Initialize an existing project safely
- **WHEN** initialization encounters existing SWF files
- **THEN** the system reports conflicts and does not overwrite project customizations without explicit user authorization

### Requirement: Project-owned defaults
The system SHALL treat initialized `.swf/` files as project-owned configuration and SHALL NOT silently replace them when the installed SWF version changes.

#### Scenario: Upgrade SWF with customized workflows
- **WHEN** a project upgrades SWF after modifying its initialized workflow files
- **THEN** the system preserves those files and reports any available schema migration separately

### Requirement: Layered configuration resolution
The system SHALL resolve built-in, user, project, workflow, phase, and run-time configuration layers in deterministic precedence order and SHALL retain the provenance of every resolved value.

#### Scenario: Phase overrides project harness
- **WHEN** project configuration selects Pi and a phase selects Claude Code
- **THEN** the phase resolves to Claude Code and the resolved configuration identifies the phase setting as the winning source

#### Scenario: Explain inherited approval mode
- **WHEN** a user requests an explanation for a phase's approval mode
- **THEN** the system reports the resolved value, its source, and any lower-precedence values it overrode

### Requirement: Configuration validation
The system SHALL validate workflow, policy, guideline, profile, and harness configuration before creating execution resources.

#### Scenario: Unsupported harness capability
- **WHEN** a phase requires session resume but its selected harness adapter does not advertise resume support
- **THEN** validation fails with the phase, requested capability, selected harness, and corrective options

#### Scenario: Invalid referenced guideline
- **WHEN** a workflow references a missing project guideline
- **THEN** validation fails before a run or Herdr resource is created
