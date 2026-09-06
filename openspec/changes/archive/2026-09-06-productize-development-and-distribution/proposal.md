## Why

SWF is currently a source-only private workspace whose CLI points at TypeScript, whose service launcher starts Nitro development mode, and whose dashboard requires Vite. Contributors lack an isolated production-like test path, and consumers cannot install, run, upgrade, or verify the exact artifact through standard package managers.

## What Changes

- Add isolated checkout-local development instances with dedicated endpoint, credentials, registry, logs, state, and lifecycle commands that never collide with an installed SWF service.
- Distinguish fast source/HMR development from production-like preview of the exact assembled distribution artifact.
- Build a production package containing compiled CLI code, inlined internal workspace modules, Nitro service output, dashboard assets, templates, migrations, and package metadata without source-checkout assumptions. Third-party dependencies are declared normally rather than bundled, so security patches continue to reach installations.
- Adopt the MIT licence, add a repository `LICENSE`, and carry licence metadata through package manifests and release evidence.
- Publish a separately installable, lockstep-versioned Pi extension while keeping internal workspace packages private unless a public SDK is intentionally introduced later.
- Serve packaged dashboard assets through the authenticated loopback service and provide an explicit dashboard-open command.
- Add production service launching and optional previewed user-service installation for macOS launchd and Linux systemd user services.
- Add CLI/service/API/state compatibility handshakes, explicit restart and migration guidance, and state-preserving upgrade and uninstall behavior.
- Assemble, inspect, pack, install, and smoke-test the exact release artifact in temporary prefixes, homes, repositories, and service namespaces before publication.
- Establish SemVer release channels beginning in `0.x`, immutable artifact promotion, npm provenance, GitHub checksums and release archives, and SBOM generation.
- Keep dependency installation, credentials, service installation, startup, project trust, remote configuration, migration, and destructive cleanup explicit and previewable.
- Publish pre-1.0 `0.x` releases, where a minor bump may carry breaking changes, until the product commits to a stable `1.0.0` contract.

## Capabilities

### New Capabilities
- `isolated-local-development`: Checkout-local CLI access, isolated development instances, fast development, production-like preview, fixtures, logs, and cleanup.
- `production-package-layout`: Compiled product package, production service, bundled dashboard and defaults, Pi extension package, and strict package-content allowlists.
- `packaged-artifact-verification`: Deterministic package assembly, temporary installation, production smoke testing, manifest inspection, checksums, and exact artifact promotion.
- `managed-user-service`: Production service process lifecycle, logs, launchd and systemd user installation, compatibility handshake, and explicit restart behavior.
- `release-distribution`: pre-1.0 SemVer channels, npm-compatible publication, provenance, GitHub releases, SBOMs, and checksums.
- `upgrade-and-uninstall`: CLI/service version skew, state migrations, safe upgrade sequencing, package removal, state preservation, and explicit destructive cleanup.

### Modified Capabilities

- `factory-project-configuration`: raises the supported Node baseline to `>=24.0.0` and requires that baseline to be declared consistently across published `engines` metadata, installation diagnostics, and an executable startup guard. No other existing capability changes; the remaining capabilities in this change are new.

## Impact

- Affects root and workspace package manifests, TypeScript build outputs, package boundaries, CLI entry points, Nitro presets, dashboard deployment, templates, Pi extension packaging, and runtime asset location.
- Adds development-instance management, production service launchers, package assembly and smoke-test tooling, release metadata, CI workflows, and GitHub release automation.
- Affects service metadata and API compatibility contracts, state migration workflows, logs, user service files, diagnostics, update guidance, and uninstall semantics.
- Introduces external publication and supply-chain responsibilities but does not permit silent dependency installation, authentication, service installation, migration, trust, or state deletion.
- Adds a repository licence and licence metadata obligations; because third-party dependencies are installed rather than inlined, their own licence files accompany them and no generated attribution bundle is required.
- Initial distribution targets npm-compatible package managers and GitHub release archives; Homebrew, APT, RPM, containers, and curl installation remain out of scope.
