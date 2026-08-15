## MODIFIED Requirements

### Requirement: Baseline installation requirements
The system SHALL support macOS and Linux with Node.js `>=22.19.0`, Git `>=2.30.0`, declared-compatible Herdr and Pi versions, OpenSpec `>=1.6.0`, and GitHub CLI (`gh`), and SHALL report native Windows support as preview while Herdr Windows support remains preview.

#### Scenario: Required executable is missing
- **WHEN** installation diagnostics cannot find Node.js, Git, Herdr, Pi, OpenSpec tooling, or `gh`
- **THEN** the system identifies the missing requirement, explains why it is required, and does not report the installation as ready

#### Scenario: Optional harness is absent
- **WHEN** Codex CLI, Claude Code CLI, GitHub Copilot CLI, or OpenCode is absent and no selected workflow uses it
- **THEN** diagnostics report it as optional rather than failing baseline readiness

### Requirement: Installation diagnostics and opt-in remediation
The system SHALL provide non-mutating installation diagnostics and explicit opt-in setup remediation for required tools, compatible versions, PATH visibility, Herdr integrations, selected harness readiness, project permissions, authentication, and negotiated structured transport capabilities.

#### Scenario: Diagnose an installation
- **WHEN** a user runs installation diagnostics
- **THEN** the system checks requirements and supported harness transports without downloading software, starting agent work, or modifying user or project configuration

#### Scenario: Install a missing supported dependency
- **WHEN** a user explicitly authorizes setup remediation
- **THEN** the system shows the source, version, destination, and command, performs the supported installation, and verifies the resulting executable and version

#### Scenario: Credentials are missing
- **WHEN** a required tool is installed but unauthenticated
- **THEN** setup may launch or explain its login flow but does not invent, silently capture, or commit credentials

#### Scenario: Installed Copilot lacks structured transport
- **WHEN** diagnostics find a Copilot version that supports only the legacy transcript adapter
- **THEN** diagnostics report its degraded settlement, recovery, blocked-input, and usage capabilities and identify the version or configuration needed for structured operation

### Requirement: Configuration validation
The system SHALL validate workflow, policy, guideline, profile, harness, and negotiated harness transport configuration before creating execution resources.

#### Scenario: Unsupported harness capability
- **WHEN** a phase requires session resume or structured settlement but its selected harness transport does not advertise that capability
- **THEN** validation fails with the phase, requested capability, selected harness, selected transport, and corrective options

#### Scenario: Invalid referenced guideline
- **WHEN** a workflow references a missing project guideline
- **THEN** validation fails before a run or Herdr resource is created

## ADDED Requirements

### Requirement: OpenCode harness configuration
The system SHALL recognize `opencode` as an optional harness in schemas, profiles, model mappings, setup requirements, adapter registration, and generated configuration examples.

#### Scenario: Phase selects OpenCode
- **WHEN** a valid phase profile selects `opencode` with a resolvable model mapping
- **THEN** SWF validates the installed OpenCode adapter and routes the invocation through its negotiated structured transport

