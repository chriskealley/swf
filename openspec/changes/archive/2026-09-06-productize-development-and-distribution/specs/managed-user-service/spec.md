## ADDED Requirements

### Requirement: Production service launcher
The installed CLI SHALL start, inspect, drain, stop, and force-stop the packaged production service with private metadata and logs. Startup SHALL verify health and compatibility before reporting success.

#### Scenario: Service publishes health
- **WHEN** `swf service start` succeeds
- **THEN** the CLI reports service version, protocol version, PID, endpoint, service home, and log location without exposing the bearer credential

#### Scenario: Service exits during startup
- **WHEN** the production process exits before becoming healthy
- **THEN** the CLI reports failure and bounded log diagnostics and does not leave metadata claiming a healthy service

### Requirement: Explicit user-service installation
SWF SHALL preview and, only after confirmation, install a user-scoped launchd agent on macOS or systemd user unit on Linux. Package installation alone SHALL NOT install, enable, or start an operating-system service.

#### Scenario: Installation is previewed
- **WHEN** a user runs the service-install command without apply confirmation
- **THEN** SWF shows destination, executable, Node path, arguments, environment, logs, enablement, and startup actions without changing the system

#### Scenario: Installation is applied
- **WHEN** the user confirms a supported service plan
- **THEN** SWF writes private user-scoped service configuration, verifies it, and performs only the explicitly approved enable or start actions

### Requirement: Portable service paths
Managed service definitions SHALL use validated absolute paths or a stable product launcher that remains resolvable after supported upgrades. Environment and PATH assumptions SHALL be explicit and diagnosable.

#### Scenario: Node manager path changes
- **WHEN** the configured Node executable is no longer available
- **THEN** service diagnostics identify the stale path and provide a previewed repair rather than repeatedly failing without explanation

### Requirement: CLI-service compatibility handshake
Authenticated service metadata SHALL include product version, API protocol version, state schema version, build identity, and compatible client range. Clients SHALL verify compatibility before mutations.

#### Scenario: Compatible patch versions connect
- **WHEN** CLI and service compatibility ranges overlap
- **THEN** normal commands continue and report versions under verbose diagnostics

#### Scenario: Service is too old
- **WHEN** the installed CLI cannot safely mutate through the running service
- **THEN** the CLI blocks the mutation and recommends an explicit service restart, upgrade, or migration sequence

### Requirement: Private service logs and diagnostics
Production stdout and stderr SHALL be directed to private rotating or bounded logs with explicit inspection commands and retention. Credentials and recognized secrets SHALL be redacted before normal log persistence.

#### Scenario: User requests recent logs
- **WHEN** an authorized local user inspects service logs
- **THEN** SWF returns or prints a bounded redacted tail and the full private log path

### Requirement: Safe managed-service removal
Service uninstall SHALL be previewed, stop and disable only the SWF-owned user service when confirmed, remove only installed service definitions and ephemeral metadata, and preserve project and operational state unless separately selected for destructive cleanup.

#### Scenario: User uninstalls service integration
- **WHEN** a confirmed service-uninstall completes
- **THEN** launchd or systemd no longer starts SWF, while project `.swf/`, `.swf-state/`, and retained user state remain intact
