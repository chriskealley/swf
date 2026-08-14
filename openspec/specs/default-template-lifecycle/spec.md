# default-template-lifecycle Specification

## Purpose
TBD - created by archiving change improve-agent-execution-defaults. Update Purpose after archive.
## Requirements
### Requirement: Versioned generated defaults
Newly generated SWF configuration SHALL record a template version and per-file provenance sufficient to compare project-owned defaults with later template versions. Generated files remain committed project configuration and SHALL NOT become remotely managed state.

#### Scenario: New project initializes
- **WHEN** `swf init` creates `.swf/`
- **THEN** the generated model routes, profiles, phase contracts, workflow, checks, policies, and template metadata identify the template version used

#### Scenario: Project edits a generated file
- **WHEN** a project customizes a generated profile or guideline
- **THEN** the customized file remains project-owned and is not overwritten by a later SWF version

### Requirement: Default inspection and diff
SWF SHALL let operators inspect current built-in defaults and compare them with project configuration, identifying unchanged generated content, project modifications, additions, removals, and conflicting upstream changes.

#### Scenario: New template is available
- **WHEN** installed SWF contains a newer template version
- **THEN** a read-only defaults diff shows candidate changes without modifying project files

#### Scenario: Project and template both changed a file
- **WHEN** a project customization overlaps a newer template change
- **THEN** the diff reports a conflict and does not claim safe automatic adoption

### Requirement: Selective explicit adoption
Operators SHALL be able to preview and explicitly adopt selected default files or individual supported settings. Adoption SHALL require confirmation, create a backup or recoverable patch, and preserve unselected project configuration.

#### Scenario: Adopt verifier profile
- **WHEN** an operator selects only the newer Verifying profile and confirms the reviewed plan
- **THEN** SWF updates only the selected configuration, records the adopted template provenance, and leaves all other files unchanged

#### Scenario: Adoption has an unresolved conflict
- **WHEN** a selected update conflicts with project customization
- **THEN** SWF refuses automatic replacement and provides a manual reconciliation artifact

### Requirement: Read-only project check discovery
SWF SHALL inspect recognized project manifests and conventional configuration files to propose plausible build, type, lint, test, and validation commands. Discovery SHALL be read-only and SHALL NOT execute commands or modify workflow configuration.

#### Scenario: Package scripts are discovered
- **WHEN** a project manifest declares build, lint, typecheck, and test scripts
- **THEN** SWF presents those scripts as candidate checks with their source and proposed phase placement

#### Scenario: Unknown project type
- **WHEN** no recognized manifest or conventional checks are found
- **THEN** discovery reports that no candidates were found and does not invent commands

### Requirement: Reviewed check adoption
Discovered checks SHALL become executable workflow configuration only after an operator reviews and explicitly adopts them. The adoption preview SHALL show command text, working directory, required status, phase placement, timeout, and source.

#### Scenario: Operator adopts tests
- **WHEN** an operator confirms a discovered test command for Verifying
- **THEN** SWF writes the reviewed check into committed project configuration and records its provenance

#### Scenario: Candidate contains shell behavior
- **WHEN** a discovered script includes shell operators or invokes another script
- **THEN** SWF displays the exact command and does not execute it during discovery or preview

### Requirement: No silent default migration
SWF upgrades, service startup, project registration, diagnostics, and workflow execution SHALL NOT silently replace, merge, or execute newly discovered defaults in an existing project.

#### Scenario: Existing project starts under newer SWF
- **WHEN** the service registers a project created by an older template
- **THEN** it may report available default updates but executes the project's committed configuration unchanged

#### Scenario: Model tier mapping is newly required
- **WHEN** an existing project lacks mappings needed by an adopted tier-based profile
- **THEN** diagnostics reports the missing explicit setup rather than silently assigning a concrete model

