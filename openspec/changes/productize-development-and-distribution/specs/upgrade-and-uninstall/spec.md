## ADDED Requirements

### Requirement: Upgrade preflight
Before applying an upgrade, SWF SHALL inspect installed CLI, running service, API protocol, state schema, managed-service definition, project configuration compatibility, and required migrations. It SHALL present an ordered preview without restarting or migrating automatically.

#### Scenario: Package is upgraded while old service runs
- **WHEN** a newer CLI detects an older running service
- **THEN** it reports both versions and blocks incompatible mutations until the user follows the reviewed restart or migration sequence

#### Scenario: No migration is required
- **WHEN** the new product is compatible with existing state and service metadata
- **THEN** upgrade guidance requires only the necessary controlled service restart

### Requirement: Explicit state migration sequencing
State migrations SHALL retain existing preview, backup, apply, verification, and rollback semantics. Package-manager upgrade hooks SHALL NOT migrate operational state or committed project configuration.

#### Scenario: Package manager installs a new version
- **WHEN** npm or pnpm replaces product files
- **THEN** user state remains unchanged until the user explicitly previews and applies any required migration

#### Scenario: Migration fails after package upgrade
- **WHEN** state migration fails
- **THEN** SWF restores its backup or offers rollback and does not start an incompatible writer against partially migrated state

### Requirement: Controlled service upgrade
A service upgrade SHALL drain or explicitly force-stop the old compatible service, validate the new service entry, start it, complete the compatibility handshake, and roll back or leave actionable stopped state if health verification fails.

#### Scenario: New service is healthy
- **WHEN** the user confirms service upgrade
- **THEN** active work is safely drained, the new service starts, and metadata identifies the new build

#### Scenario: New service fails health check
- **WHEN** the replacement service cannot become healthy
- **THEN** SWF preserves logs and metadata needed for diagnosis and does not claim a successful upgrade

### Requirement: State-preserving package uninstall
Removing the product package SHALL not delete user service state, project `.swf/`, project `.swf-state/`, exported runs, credentials, or audit history. Documentation and diagnostics SHALL explain any remaining managed service that references a removed package.

#### Scenario: Package is removed before service uninstall
- **WHEN** a package manager removes SWF while a managed-service definition remains
- **THEN** no state is deleted and reinstall or explicit service-definition cleanup remains possible

### Requirement: Explicit destructive cleanup
SWF SHALL provide previewed, scoped, separately confirmed cleanup for user service metadata, logs, credentials, registries, caches, development instances, and project operational state. Destructive cleanup SHALL never be implied by package or service uninstall.

#### Scenario: User previews complete cleanup
- **WHEN** complete cleanup is requested
- **THEN** SWF lists every candidate path, ownership basis, effect, and preserved Git configuration before asking for confirmation

#### Scenario: Project state is not selected
- **WHEN** cleanup confirms only user service data
- **THEN** every project `.swf-state/` directory remains untouched

### Requirement: Downgrade safety
SWF SHALL detect when installed product or service versions cannot safely read current state. Downgrade SHALL require a compatible state backup or explicit supported path and SHALL fail closed otherwise.

#### Scenario: Older service sees future state schema
- **WHEN** a downgraded service encounters a newer unsupported state version
- **THEN** it refuses to become the writer and reports the minimum compatible product or backup restoration path

### Requirement: Release compatibility documentation
Every release SHALL document supported Node, Herdr, Pi, OpenSpec, optional harness, API protocol, state schema, prior upgrade range, and known downgrade limitations.

#### Scenario: User plans an upgrade
- **WHEN** a user inspects release metadata
- **THEN** they can determine prerequisites and whether intermediate upgrades or migrations are required before installing
