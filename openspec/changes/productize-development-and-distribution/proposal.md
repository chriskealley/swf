## Why

SWF is currently a source-only private workspace whose CLI points at TypeScript, whose service launcher starts Nitro development mode, and whose dashboard requires Vite. Contributors lack an isolated production-like test path, and consumers cannot install, run, upgrade, or verify the exact artifact through standard package managers.

## What Changes

- Add isolated checkout-local development instances with dedicated endpoint, credentials, registry, logs, state, and lifecycle commands that never collide with an installed SWF service.
- Distinguish fast source/HMR development from production-like preview of the exact assembled distribution artifact.
- Build a production package containing compiled CLI code, bundled runtime modules, Nitro service output, dashboard assets, templates, migrations, and package metadata without source-checkout assumptions.
- Publish a separately installable, lockstep-versioned Pi extension while keeping internal workspace packages private unless a public SDK is intentionally introduced later.
- Serve packaged dashboard assets through the authenticated loopback service and provide an explicit dashboard-open command.
- Add production service launching and optional previewed user-service installation for macOS launchd and Linux systemd user services.
- Add CLI/service/API/state compatibility handshakes, explicit restart and migration guidance, and state-preserving upgrade and uninstall behavior.
- Assemble, inspect, pack, install, and smoke-test the exact release artifact in temporary prefixes, homes, repositories, and service namespaces before publication.
- Establish SemVer release channels, immutable artifact promotion, npm provenance, GitHub checksums and release archives, SBOM generation, and Homebrew distribution from the verified archive.
- Keep dependency installation, credentials, service installation, startup, project trust, remote configuration, migration, and destructive cleanup explicit and previewable.

## Capabilities

### New Capabilities
- `isolated-local-development`: Checkout-local CLI access, isolated development instances, fast development, production-like preview, fixtures, logs, and cleanup.
- `production-package-layout`: Compiled product package, production service, bundled dashboard and defaults, Pi extension package, and strict package-content allowlists.
- `packaged-artifact-verification`: Deterministic package assembly, temporary installation, production smoke testing, manifest inspection, checksums, and exact artifact promotion.
- `managed-user-service`: Production service process lifecycle, logs, launchd and systemd user installation, compatibility handshake, and explicit restart behavior.
- `release-distribution`: SemVer channels, npm-compatible publication, provenance, GitHub releases, SBOMs, checksums, and Homebrew formula delivery.
- `upgrade-and-uninstall`: CLI/service version skew, state migrations, safe upgrade sequencing, package removal, state preservation, and explicit destructive cleanup.

### Modified Capabilities

None. The repository does not yet contain archived main capability specs for development tooling or packaged distribution.

## Impact

- Affects root and workspace package manifests, TypeScript build outputs, package boundaries, CLI entry points, Nitro presets, dashboard deployment, templates, Pi extension packaging, and runtime asset location.
- Adds development-instance management, production service launchers, package assembly and smoke-test tooling, release metadata, CI workflows, GitHub release automation, and Homebrew formula generation.
- Affects service metadata and API compatibility contracts, state migration workflows, logs, user service files, diagnostics, update guidance, and uninstall semantics.
- Introduces external publication and supply-chain responsibilities but does not permit silent dependency installation, authentication, service installation, migration, trust, or state deletion.
- Initial distribution targets npm-compatible package managers, GitHub release archives, and Homebrew; APT, RPM, containers, and curl installation remain out of scope.
