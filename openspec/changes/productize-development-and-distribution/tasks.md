## 1. Product Version and Build Metadata

- [ ] 1.1 Define product, build commit, API protocol, state schema, compatible client, and Pi extension compatibility metadata schemas
- [ ] 1.2 Raise the supported Node baseline to `>=24.0.0` consistently across root and workspace manifests, `packages/core/src/requirements.ts`, and CI workflows
- [ ] 1.3 Add a runtime Node version guard to the compiled CLI entry that fails with an actionable message, since `engines` is advisory for npm installs
- [ ] 1.4 Generate immutable build metadata during development preview and release assembly
- [ ] 1.5 Expose version/build metadata through `swf --version`, service metadata, health diagnostics, and authenticated compatibility queries
- [ ] 1.6 Add compatibility range evaluation tests for CLI, service, state, and Pi extension combinations

## 2. Compiled Product Entries

- [ ] 2.1 Add a production TypeScript build or bundling configuration for the CLI with a Node executable entry and no `tsx` dependency
- [ ] 2.2 Bundle or otherwise package core and integration runtime code without resolving private workspace packages in consumer installations
- [ ] 2.3 Configure Nitro production output for the packaged Node service and remove workspace and development-server assumptions
- [ ] 2.4 Build dashboard production assets and integrate them into authenticated loopback service delivery
- [ ] 2.5 Add packaged runtime asset resolution for templates, schemas, migrations, dashboard files, license, notices, and build metadata
- [ ] 2.6 Add `swf dashboard open` behavior that starts or locates a compatible service and opens or prints the packaged dashboard URL
- [ ] 2.7 Add production-entry tests from paths containing spaces and arbitrary current working directories

## 3. Product Package and Pi Extension Layout

- [ ] 3.1 Reserve the resolved package names `@chriskealley/swf` and `@chriskealley/swf-pi` and configure public access for scoped publication
- [ ] 3.2 Add the repository `LICENSE` (MIT) and declare a matching licence identifier in every published manifest
- [ ] 3.3 Verify that no published manifest declares a `workspace:` dependency, an unpublished internal package, or a build-only tool such as `tsx` or `nitropack` as a runtime dependency
- [ ] 3.4 Create release package manifests with versions, engines, bin, files, license, repository, dependencies, publish configuration, and provenance metadata
- [ ] 3.5 Define a strict product content allowlist and assemble release staging from an empty directory
- [ ] 3.6 Generate a per-file path, size, mode, and SHA-256 manifest and reject unexpected or forbidden content
- [ ] 3.7 Ensure package contents exclude credentials, `.swf-state`, `.swf-dev`, logs, coverage, arbitrary fixtures, development output, and source-only runtime assumptions
- [ ] 3.8 Build the Pi extension as compiled separately installable output with lockstep release version and compatible service/API range
- [ ] 3.9 Verify internal workspace packages remain private and all product runtime imports resolve from the staged package
- [ ] 3.10 Add package-size budgets and package-content regression tests

## 4. Isolated Development Instances

- [ ] 4.1 Define named development-instance metadata for mode, checkout, commit, endpoint, service home, credential, registry, logs, package path, and process identity
- [ ] 4.2 Add a checkout-local CLI command or executable that requires no global link or shell function and preserves target project cwd semantics
- [ ] 4.3 Allocate isolated loopback endpoints and create private `.swf-dev/<instance>/` homes without reading or modifying installed SWF state
- [ ] 4.4 Add development instance start, list, status, logs, stop, restart, and confirmed cleanup commands
- [ ] 4.5 Implement fast source development with source maps and safe service/dashboard watch behavior
- [ ] 4.6 Detect unsafe HMR ownership replacement and perform or recommend a controlled isolated-service restart
- [ ] 4.7 Support multiple concurrent named development instances without shared credentials, registries, ports, or logs
- [ ] 4.8 Add tests proving installed stable service and user metadata remain untouched by development instances

## 5. Production-Like Local Preview

- [ ] 5.1 Add a preview command that builds and stages the exact product layout in an isolated development instance
- [ ] 5.2 Launch only the staged compiled CLI, production Nitro service, and packaged dashboard in preview mode
- [ ] 5.3 Reject preview artifacts that resolve to TypeScript source, `tsx`, workspace filters, Nitro dev, Vite dev, or source-repository assets
- [ ] 5.4 Report preview artifact version, source commit, checksum manifest, endpoint, state, logs, and exact executable
- [ ] 5.5 Add temporary committed Git/OpenSpec fixture generation with local-branch delivery and optional retention
- [ ] 5.6 Keep live harness and hosted delivery execution explicit opt-ins in preview and fixture workflows
- [ ] 5.7 Add end-to-end preview tests from a clean checkout and isolated fixture

## 6. Exact Packaged Artifact Verification

- [ ] 6.1 Add deterministic product and Pi extension packing commands and inspect `npm pack` output before publication
- [ ] 6.2 Verify bin targets, executable behavior, engines, dependencies, files, license, package size, and forbidden paths
- [ ] 6.3 Install the exact tarball into a temporary prefix with isolated HOME, SWF config/service homes, cache, endpoint, and Git fixture
- [ ] 6.4 Prove smoke tests resolve no modules or assets from the source workspace
- [ ] 6.5 Smoke-test installed version/help, doctor, project initialization, production service start/health/authenticated query/stop, dashboard assets, and private permissions
- [ ] 6.6 Smoke-test packaged templates and migration discovery and statically or dynamically validate Pi extension loading
- [ ] 6.7 Simulate package uninstall and verify user and project state are preserved
- [ ] 6.8 Generate artifact checksums and a release evidence manifest containing source, toolchain, lockfile, files, tests, provenance, and destinations
- [ ] 6.9 Add reproducibility comparison and report known nondeterministic archive metadata
- [ ] 6.10 Fail verification for dirty stable-release input or label explicitly allowed dirty output as non-publishable development artifacts

## 7. Production Service Lifecycle

- [ ] 7.1 Replace the production default `pnpm --filter ... dev` launcher with direct argument-safe spawning of the packaged Node service entry
- [ ] 7.2 Add private production stdout/stderr logs, bounded rotation or retention, redaction, and explicit log inspection
- [ ] 7.3 Wait for service metadata, health, authentication, and compatibility handshake before reporting successful startup
- [ ] 7.4 Remove stale metadata safely when startup exits and report bounded logs, command identity, and next diagnostic action
- [ ] 7.5 Preserve graceful drain, stop, force-stop, and owned-work interruption semantics in the packaged launcher
- [ ] 7.6 Add service lifecycle tests for arbitrary cwd, paths with spaces, stale metadata, existing service, incompatible service, crash, logs, and permissions

## 8. Managed User Service

- [ ] 8.1 Define preview plans for macOS launchd user agents and Linux systemd user units with destinations, paths, arguments, environment, logs, enablement, and startup actions
- [ ] 8.2 Implement explicitly confirmed service installation without package-install hooks or implicit startup
- [ ] 8.3 Validate installed service definitions and report stale Node, package, executable, or environment paths
- [ ] 8.4 Implement previewed repair or reinstall of owned managed-service definitions after supported package path changes
- [ ] 8.5 Implement previewed service uninstall that stops and disables only owned user services and preserves all state
- [ ] 8.6 Add launchd fixture/validation tests on macOS and systemd user-unit fixture/validation tests on Linux
- [ ] 8.7 Document manual foreground or detached fallback where managed services are unsupported

## 9. Upgrade, Migration, and Downgrade Safety

- [ ] 9.1 Add upgrade preflight comparing installed CLI, running service, API protocol, state schema, build identity, managed unit, and project compatibility
- [ ] 9.2 Render an ordered preview for restart-only, migration-required, incompatible, and downgrade cases without mutation
- [ ] 9.3 Integrate existing migration preview, backup, apply, verification, and rollback into packaged upgrade sequencing
- [ ] 9.4 Ensure package-manager installation hooks never restart services, migrate state, or change committed project configuration
- [ ] 9.5 Implement controlled service upgrade with drain, explicit force option, new-entry validation, health handshake, and failure diagnostics
- [ ] 9.6 Refuse writer startup when an older service encounters an unsupported future state schema
- [ ] 9.7 Add compatibility and acceptance tests for patch upgrade, API skew, state migration, migration failure, failed replacement health, downgrade refusal, and backup restoration

## 10. State-Preserving Uninstall and Cleanup

- [ ] 10.1 Document and test that package removal preserves user service home, credentials, registries, logs, audits, exports, project `.swf/`, and project `.swf-state/`
- [ ] 10.2 Diagnose managed-service definitions that remain after product removal and provide reinstall or explicit cleanup guidance
- [ ] 10.3 Add previewed scoped cleanup for user service metadata, credentials, logs, caches, development instances, and selected project operational state
- [ ] 10.4 Require separate confirmation for destructive cleanup and list every path, ownership basis, effect, and preserved Git configuration
- [ ] 10.5 Add tests proving service uninstall and user-scope cleanup never delete unselected project state or unowned resources

## 11. Release Automation and Supply Chain

- [ ] 11.1 Define SemVer stable and next channel policies including pre-1.0 `0.x` semantics, tag formats, registry tags, and release authorization rules
- [ ] 11.2 Require an explicit prerelease registry tag for every `next` publication so a prerelease never becomes the default install
- [ ] 11.3 Order publication before Git tagging so a failed publish never leaves a tag referencing an unpublished version
- [ ] 11.4 Add protected CI workflows for clean build, checks, unit, integration, E2E, package inspection, clean-install smoke, security validation, and OpenSpec validation
- [ ] 11.5 Generate npm provenance, GitHub checksums, product archives, SBOM, dependency/license inventory, compatibility metadata, and release evidence
- [ ] 11.6 Record the resolved dependency closure in release evidence and document that it is outside verified artifact identity
- [ ] 11.7 Ensure untrusted pull-request jobs cannot access publication credentials or mutate release destinations
- [ ] 11.8 Promote the exact previously verified artifact checksums without rebuilding in publication jobs
- [ ] 11.9 Publish product and Pi extension packages coherently to stable or next registry tags
- [ ] 11.10 Create immutable Git tags and GitHub stable or prerelease entries with verified archives, notes, checksums, SBOM, and migration guidance
- [ ] 11.11 Add release rollback and partial-publication procedures that never overwrite immutable published versions

## 12. Documentation and Release Acceptance

- [ ] 12.1 Replace source shell-function instructions with checkout-local development and preview workflows
- [ ] 12.2 Document npm, pnpm, and GitHub archive installation with explicit prerequisite and setup boundaries
- [ ] 12.3 Document fast development, isolated instances, fixtures, preview, package verification, release channels, service logs, and managed services
- [ ] 12.4 Document version compatibility, service restart, migration, downgrade, uninstall, state preservation, and destructive cleanup
- [ ] 12.5 Document package contents, supply-chain verification, checksums, provenance, SBOM, and release evidence
- [ ] 12.6 Clearly label Homebrew, APT, RPM, containers, native Windows services, and curl installers unsupported until separately specified
- [ ] 12.7 Run formatting, lint, type checking, unit, integration, E2E, package smoke, OpenSpec validation, and Git whitespace verification
- [ ] 12.8 Perform a release-candidate rehearsal that publishes nowhere, installs the exact artifacts through npm/pnpm-style paths on a machine without the source checkout, and retains complete verification evidence
