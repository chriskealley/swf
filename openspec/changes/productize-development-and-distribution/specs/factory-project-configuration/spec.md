## MODIFIED Requirements

### Requirement: Baseline installation requirements
The system SHALL support macOS and Linux with Node.js `>=24.0.0`, Git `>=2.30.0`, declared-compatible Herdr and Pi versions, OpenSpec `>=1.6.0`, and GitHub CLI (`gh`), and SHALL report native Windows support as preview while Herdr Windows support remains preview.

The Node baseline SHALL be declared consistently across published package `engines` metadata, installation diagnostics, and release compatibility documentation. Because `engines` is advisory for some package managers and does not prevent installation, the executable SHALL additionally enforce the baseline at startup and fail with an actionable message rather than surfacing a runtime or syntax error.

#### Scenario: Required executable is missing
- **WHEN** installation diagnostics cannot find Node.js, Git, Herdr, Pi, OpenSpec tooling, or `gh`
- **THEN** the system identifies the missing requirement, explains why it is required, and does not report the installation as ready

#### Scenario: Optional harness is absent
- **WHEN** Codex CLI, Claude Code CLI, or GitHub Copilot CLI is absent and no selected workflow uses it
- **THEN** diagnostics report it as optional rather than failing baseline readiness

#### Scenario: Unsupported Node runtime invokes the executable
- **WHEN** the installed executable is run on a Node release below the declared baseline
- **THEN** it reports the required and detected versions and exits without executing further product code

#### Scenario: Declared baselines disagree
- **WHEN** published `engines` metadata, installation diagnostics, and the executable's startup guard do not declare the same Node baseline
- **THEN** verification fails, because a user could install a product its own diagnostics reject
