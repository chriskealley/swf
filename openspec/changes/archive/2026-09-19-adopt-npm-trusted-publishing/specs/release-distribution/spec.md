# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Supply-chain evidence
Stable releases SHALL generate and retain checksums, an SBOM, dependency and license inventory, package provenance, source commit, build environment identity, and publication audit. Credentials SHALL be provided only through protected publication environments, and registry publication credentials SHALL be short-lived identities minted for the individual workflow run rather than stored long-lived tokens.

#### Scenario: Release workflow runs on an untrusted contribution
- **WHEN** code originates from an untrusted pull-request context
- **THEN** publication credentials are unavailable and no release destination can be mutated

#### Scenario: Publication credential outlives its run
- **WHEN** a release credential able to mutate the registry would remain valid after the workflow run that used it
- **THEN** the release trust boundary is violated and release validation rejects the configuration
