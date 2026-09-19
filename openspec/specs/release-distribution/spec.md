# release-distribution Specification

## Purpose

Define version channels, npm-compatible and GitHub distribution, gated automation, supply-chain evidence, and initial distribution scope.

## Requirements

### Requirement: Semantic versioning and release channels
SWF SHALL use Semantic Versioning and publish explicit `stable` and `next` channels. Prerelease artifacts SHALL be distinguishable in package metadata, service metadata, logs, and diagnostics. Releases SHALL begin in the pre-1.0 `0.x` series, where a minor increment MAY introduce breaking changes; `1.0.0` SHALL be reserved for an explicit stability commitment.

#### Scenario: Stable release is published
- **WHEN** version `0.2.0` passes release verification and approval
- **THEN** it is published to the stable package tag and corresponding immutable Git tag and GitHub release

#### Scenario: Next release is published
- **WHEN** version `0.3.0-next.2` is approved
- **THEN** it is published only to the prerelease channel with an explicit prerelease tag and does not replace the stable default

#### Scenario: Pre-1.0 breaking change ships
- **WHEN** a `0.x` minor release changes behavior incompatibly
- **THEN** release notes state the breaking change and the pre-1.0 policy that permits it

#### Scenario: Published version cannot be reused
- **WHEN** a defect is found in an already published version
- **THEN** the fix is released as a new version and the published version is never overwritten or reused

### Requirement: npm-compatible publication
The canonical product and Pi extension packages SHALL be publishable through an npm-compatible registry with correct names, versions, engine constraints, dependencies, binaries, files, license, repository metadata, integrity, and provenance. The declared licence SHALL be MIT and SHALL match the repository `LICENSE`. Scoped packages SHALL be published with public access explicitly configured.

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

### Requirement: Gated release automation
Release automation SHALL require successful build, checks, unit, integration, E2E, package inspection, clean installation smoke, security checks, and OpenSpec validation before publication. Stable publication SHALL require explicit release authorization.

#### Scenario: Smoke test fails
- **WHEN** the packaged production service smoke test fails
- **THEN** no registry tag, Git tag, or GitHub release is published

### Requirement: Supply-chain evidence
Stable releases SHALL generate and retain checksums, an SBOM, dependency and license inventory, package provenance, source commit, build environment identity, and publication audit. Credentials SHALL be provided only through protected publication environments, and registry publication credentials SHALL be short-lived identities minted for the individual workflow run rather than stored long-lived tokens.

#### Scenario: Release workflow runs on an untrusted contribution
- **WHEN** code originates from an untrusted pull-request context
- **THEN** publication credentials are unavailable and no release destination can be mutated

#### Scenario: Publication credential outlives its run
- **WHEN** a release credential able to mutate the registry would remain valid after the workflow run that used it
- **THEN** the release trust boundary is violated and release validation rejects the configuration

### Requirement: Tokenless registry authentication
Registry publication SHALL authenticate through workflow-bound OpenID Connect trusted publishing rather than a long-lived npm credential. Release automation SHALL NOT reference a reusable npm publication token in any form, including a repository or environment secret, a `.npmrc` auth entry, or an authentication environment variable. The publishing job SHALL run an npm version that supports trusted publishing, and publication SHALL fail rather than fall back to another authentication method when the short-lived identity is unavailable.

#### Scenario: Publication succeeds without a stored credential
- **WHEN** the release workflow publishes a verified tarball from the protected release environment with no npm publication token configured
- **THEN** the registry accepts the publication using the workflow's short-lived OIDC identity and records provenance for it

#### Scenario: Release automation reintroduces a long-lived token
- **WHEN** a publishing workflow references an npm publication token or sets an npm authentication environment variable
- **THEN** static release validation fails and reports the prohibited long-lived credential

#### Scenario: Publishing toolchain is too old for trusted publishing
- **WHEN** a publishing workflow's npm version does not meet the minimum that supports trusted publishing
- **THEN** static release validation fails and reports the unmet toolchain baseline

#### Scenario: Trusted identity is unavailable
- **WHEN** the registry rejects or cannot verify the workflow's OIDC identity
- **THEN** publication fails, no fallback credential is used, and no Git tag or GitHub release is created

### Requirement: Registry trusted-publisher configuration
Each publicly published package SHALL have a registry-side trusted publisher bound to this repository, the exact publishing workflow filename, and the protected publication environment. This configuration is an external deployment prerequisite that repository automation SHALL NOT create, and it SHALL be documented for `@chriskealley/swf` and `@chriskealley/swf-pi` so an operator can reproduce it.

#### Scenario: Operator prepares a package for release
- **WHEN** an operator prepares a package to be published by the release workflow
- **THEN** release documentation states the repository, workflow filename, and protected environment to register as that package's trusted publisher

#### Scenario: A package has no trusted publisher registered
- **WHEN** the release workflow publishes a package whose registry trusted publisher is missing or bound to a different workflow or environment
- **THEN** that publication fails before the Git tag is created, and the documented fail-closed recovery path for incomplete two-package publication applies

### Requirement: Initial distribution scope
Initial supported distribution SHALL include npm-compatible registries and GitHub release archives. Homebrew, APT, RPM, container images, and curl-pipe installers SHALL require future explicit proposals.

#### Scenario: Unsupported installer is requested
- **WHEN** documentation or automation references an unsupported distribution channel
- **THEN** release validation rejects the claim or clearly labels it experimental and non-supported
