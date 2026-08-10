## ADDED Requirements

### Requirement: Semantic versioning and release channels
SWF SHALL use Semantic Versioning and publish explicit `stable` and `next` channels. Prerelease artifacts SHALL be distinguishable in package metadata, service metadata, logs, and diagnostics.

#### Scenario: Stable release is published
- **WHEN** version `1.2.0` passes release verification and approval
- **THEN** it is published to the stable package tag and corresponding immutable Git tag and GitHub release

#### Scenario: Next release is published
- **WHEN** version `1.3.0-next.2` is approved
- **THEN** it is published only to the prerelease channel and does not replace the stable default

### Requirement: npm-compatible publication
The canonical product and Pi extension packages SHALL be publishable through an npm-compatible registry with correct names, versions, engine constraints, dependencies, binaries, files, license, repository metadata, integrity, and provenance.

#### Scenario: Registry package is installed with pnpm
- **WHEN** a user installs the canonical package globally using pnpm
- **THEN** the same verified `swf` product files and behavior are installed as with npm

#### Scenario: Publication lacks provenance
- **WHEN** stable release policy requires registry provenance but the publishing environment cannot produce it
- **THEN** stable publication fails

### Requirement: GitHub release archives
Each published version SHALL have immutable GitHub release archives, checksums, release notes, SBOM, compatibility information, and links to registry packages. Archives SHALL be derived from verified artifacts rather than a generic source archive.

#### Scenario: User verifies archive
- **WHEN** a user downloads a release archive
- **THEN** they can validate it against the published checksum and release evidence

### Requirement: Homebrew distribution
Stable and optionally prerelease SWF versions SHALL be installable through an explicitly maintained Homebrew tap or formula consuming the verified GitHub release artifact and checksum. The formula SHALL declare its Node/runtime requirements and SHALL NOT download undeclared runtime code during installation.

#### Scenario: Homebrew installs SWF
- **WHEN** a macOS user installs the formula
- **THEN** Homebrew installs the verified product, exposes `swf`, and does not silently install or start harnesses, credentials, projects, or user services

#### Scenario: Formula checksum is stale
- **WHEN** the release artifact checksum differs from formula metadata
- **THEN** Homebrew installation fails integrity verification

### Requirement: Gated release automation
Release automation SHALL require successful build, checks, unit, integration, E2E, package inspection, clean installation smoke, security checks, and OpenSpec validation before publication. Stable publication SHALL require explicit release authorization.

#### Scenario: Smoke test fails
- **WHEN** the packaged production service smoke test fails
- **THEN** no registry tag, Git tag, GitHub release, or Homebrew update is published

### Requirement: Supply-chain evidence
Stable releases SHALL generate and retain checksums, an SBOM, dependency and license inventory, package provenance, source commit, build environment identity, and publication audit. Secrets SHALL be provided only through protected publication environments.

#### Scenario: Release workflow runs on an untrusted contribution
- **WHEN** code originates from an untrusted pull-request context
- **THEN** publication credentials are unavailable and no release destination can be mutated

### Requirement: Initial distribution scope
Initial supported distribution SHALL include npm-compatible registries, GitHub release archives, and Homebrew. APT, RPM, container images, and curl-pipe installers SHALL require future explicit proposals.

#### Scenario: Unsupported installer is requested
- **WHEN** documentation or automation references an unsupported distribution channel
- **THEN** release validation rejects the claim or clearly labels it experimental and non-supported
