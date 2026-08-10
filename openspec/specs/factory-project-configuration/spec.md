# factory-project-configuration Specification

## Purpose

Define supported prerequisites, project initialization, committed defaults, reusable activities, and layered configuration.

## Requirements

### Requirement: Baseline installation requirements
The system SHALL support macOS and Linux with Node.js `>=22.19.0`, Git `>=2.30.0`, declared-compatible Herdr and Pi versions, OpenSpec `>=1.6.0`, and GitHub CLI (`gh`), and SHALL report native Windows support as preview while Herdr Windows support remains preview.

#### Scenario: Required executable is missing
- **WHEN** installation diagnostics cannot find Node.js, Git, Herdr, Pi, OpenSpec tooling, or `gh`
- **THEN** the system identifies the missing requirement, explains why it is required, and does not report the installation as ready

#### Scenario: Optional harness is absent
- **WHEN** Codex CLI, Claude Code CLI, or GitHub Copilot CLI is absent and no selected workflow uses it
- **THEN** diagnostics report it as optional rather than failing baseline readiness

### Requirement: Terminal compatibility
Interactive Pi and Herdr use SHALL require a modern UTF-8 and ANSI-capable interactive terminal but SHALL NOT require Ghostty or any specific terminal emulator.

#### Scenario: Run from a supported terminal
- **WHEN** a user launches interactive operation from Ghostty, iTerm2, WezTerm, Kitty, macOS Terminal, GNOME Terminal, or another compatible terminal
- **THEN** the system accepts the terminal based on capabilities rather than product name

#### Scenario: Run the service without a terminal UI
- **WHEN** the persistent service or JSON CLI mode runs without an interactive terminal
- **THEN** the system does not require Ghostty or another graphical terminal emulator

### Requirement: Installation diagnostics and opt-in remediation
The system SHALL provide non-mutating installation diagnostics and explicit opt-in setup remediation for required tools, compatible versions, PATH visibility, Herdr integrations, selected harness readiness, project permissions, and authentication.

#### Scenario: Diagnose an installation
- **WHEN** a user runs installation diagnostics
- **THEN** the system checks requirements without downloading software or modifying user or project configuration

#### Scenario: Install a missing supported dependency
- **WHEN** a user explicitly authorizes setup remediation
- **THEN** the system shows the source, version, destination, and command, performs the supported installation, and verifies the resulting executable and version

#### Scenario: Credentials are missing
- **WHEN** a required tool is installed but unauthenticated
- **THEN** setup may launch or explain its login flow but does not invent, silently capture, or commit credentials

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

### Requirement: Default workflow and profiles
The initialized project SHALL include a customizable default workflow with ordered Planning, Building, Reviewing, Verifying, and Releasing phases and SHALL include matching `planner`, `builder`, `reviewer`, `verifier`, and `releaser` profiles.

#### Scenario: Initialize the standard workflow
- **WHEN** a user initializes a project with default options
- **THEN** the generated project configuration contains the five ordered phases and their matching profiles

#### Scenario: Customize the standard workflow
- **WHEN** a project removes, reorders, replaces, or extends initialized phases or profiles
- **THEN** the system validates and uses the project-owned configuration without silently restoring factory defaults

### Requirement: Reusable workflow activities
The initialized project SHALL provide reusable activities or optional workflows for designing, testing, documenting, and writing without requiring those activities in every run.

#### Scenario: Add documentation to a project workflow
- **WHEN** a project includes the initialized documenting activity in its workflow
- **THEN** the system resolves and executes it according to that project's placement and configuration

### Requirement: Canonical operator skill definitions
The project SHALL keep canonical SWF operator skill definitions under committed `.swf/` configuration and SHALL generate or expose thin harness-specific integrations that delegate mutations to the SWF service or CLI.

#### Scenario: Initialize operator skills
- **WHEN** a project is initialized for supported harnesses
- **THEN** explore, new, run, next, phase, status, approval, and artifact-inspection skills or native commands are available without duplicating workflow state logic

#### Scenario: Workflow configuration changes
- **WHEN** project workflow definitions change
- **THEN** operator skills continue delegating to service-resolved workflow behavior rather than embedding stale phase logic

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
