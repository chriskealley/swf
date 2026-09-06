## ADDED Requirements

### Requirement: Checkout-local SWF command
A contributor SHALL be able to invoke the current checkout's CLI through one documented command or generated checkout-local executable without defining a shell function, globally linking a package, or changing the target project's working directory semantics.

#### Scenario: Command targets another project
- **WHEN** a contributor invokes the checkout-local CLI with a target project path
- **THEN** SWF resolves the target project correctly while loading CLI and service code from the checkout

#### Scenario: Installed SWF also exists
- **WHEN** an installed `swf` executable is present on PATH
- **THEN** the checkout-local command unambiguously identifies and uses the checkout version

### Requirement: Isolated development instances
Development instances SHALL use isolated service home, credential, registry, audit, logs, endpoint, PID, and operational state distinct from the installed user service. Instance identity and paths SHALL be displayed before use.

#### Scenario: Stable service is running
- **WHEN** a contributor starts a development instance while the installed service is active
- **THEN** the development instance selects an isolated endpoint and state namespace without stopping, adopting, or modifying the installed service

#### Scenario: Two development instances run
- **WHEN** two named development instances are started
- **THEN** each has distinct credentials, endpoints, process metadata, project registry, and logs

### Requirement: Fast development mode
The repository SHALL provide a fast development mode with source maps and appropriate service or dashboard watch behavior. HMR replacement SHALL not create duplicate service ownership or corrupt the isolated development registry.

#### Scenario: Service code changes
- **WHEN** a developer edits service code during fast development
- **THEN** the development service reloads or restarts predictably and retains or safely reconstructs its isolated state

#### Scenario: HMR cannot preserve ownership
- **WHEN** a code change is incompatible with safe in-process replacement
- **THEN** the developer tooling performs or recommends an explicit controlled development-service restart rather than serving duplicate schedulers

### Requirement: Production-like preview mode
The repository SHALL provide a preview mode that builds and runs the same assembled product layout intended for release, without HMR or workspace-only runtime resolution, while retaining an isolated development namespace.

#### Scenario: Preview starts
- **WHEN** a contributor runs production-like preview
- **THEN** SWF assembles the package, launches the compiled production service and CLI, serves packaged dashboard assets, and reports the artifact identity

#### Scenario: Source-only import remains
- **WHEN** previewed output still depends on TypeScript source, `tsx`, a workspace filter, or a Vite development server
- **THEN** preview fails before claiming the artifact is production-ready

### Requirement: Development lifecycle and diagnostics
Contributors SHALL be able to list, inspect, stop, restart, and clean named development instances, with logs and process health available through explicit commands. Cleanup SHALL affect only resources belonging to the selected development instance.

#### Scenario: Instance fails to start
- **WHEN** the development service exits before publishing healthy metadata
- **THEN** the launcher reports the log path, exit status, attempted command, and safe next diagnostic action

#### Scenario: Instance cleanup is requested
- **WHEN** a contributor confirms cleanup of one development instance
- **THEN** only that instance's processes, credentials, registry, temporary package, and ephemeral state are removed

### Requirement: Reproducible local fixtures
Development tooling SHALL provide or generate temporary Git and OpenSpec fixtures for smoke testing without requiring contributors to modify personal repositories. Live harness and hosted-delivery tests remain explicit opt-ins.

#### Scenario: Fixture smoke test runs
- **WHEN** a contributor requests the default local fixture
- **THEN** tooling creates an isolated committed Git repository, initializes required configuration, uses local-branch delivery, and tears it down after the test unless retention is requested

#### Scenario: Live harness is not enabled
- **WHEN** normal development tests run without the live opt-in
- **THEN** no paid or authenticated harness invocation is started
