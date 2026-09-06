## ADDED Requirements

### Requirement: Compiled production CLI
The distributed SWF product SHALL expose an executable `swf` binary backed by compiled JavaScript and declared runtime dependencies. It SHALL NOT require `tsx`, repository TypeScript source, pnpm workspace filters, or development dependencies at runtime.

#### Scenario: CLI runs from global installation
- **WHEN** the package is installed into a clean compatible Node prefix
- **THEN** `swf --version`, `swf --help`, and `swf doctor` run without access to the source repository

#### Scenario: TypeScript source is absent
- **WHEN** package contents omit application `.ts` sources
- **THEN** all supported production commands continue to work from compiled output

### Requirement: Self-contained production service
The product package SHALL include a production Nitro service entry and all required bundled or declared runtime modules. `swf service start` SHALL locate and launch that entry independently of the caller's current directory.

#### Scenario: Service starts outside the package directory
- **WHEN** an installed user runs `swf service start` from an arbitrary directory
- **THEN** SWF launches the packaged production service rather than `nitro dev` or a workspace command

#### Scenario: Package path contains spaces
- **WHEN** the product is installed below a path containing spaces
- **THEN** the launcher uses argument-safe process spawning and starts the correct service entry

### Requirement: Packaged dashboard
The product SHALL include built dashboard assets served through authenticated loopback service routes or another packaged production entry. Consumers SHALL NOT need Vite or repository source to use the dashboard.

#### Scenario: Dashboard opens
- **WHEN** an installed user requests the dashboard
- **THEN** SWF starts or locates the compatible service and opens or prints its loopback dashboard URL

#### Scenario: Remote origin requests dashboard assets
- **WHEN** a non-loopback or disallowed origin requests packaged dashboard resources or APIs
- **THEN** existing loopback, origin, credential, CSP, and referrer protections remain enforced

### Requirement: Packaged runtime assets
The product package SHALL include required workflow templates, profile and policy defaults, schemas, migrations, static assets, license, notices, and version metadata. Runtime asset lookup SHALL be relative to the installed product rather than repository layout assumptions.

#### Scenario: New project initializes
- **WHEN** installed SWF initializes a project
- **THEN** it reads packaged templates and creates the same validated project-owned defaults verified during release testing

### Requirement: Strict package allowlist
Package assembly SHALL use an explicit content allowlist and reject credentials, `.swf-state`, development logs, test fixtures not intended for consumers, source maps not selected by policy, generated development output, and unrelated repository files.

#### Scenario: Package contents are inspected
- **WHEN** the release package is assembled
- **THEN** an auditable manifest lists every included file, size, mode, and checksum and rejects forbidden paths or unexpected additions

### Requirement: Lockstep Pi extension package
The Pi extension SHALL be distributed as a separately installable Pi-compatible package with a declared compatible SWF service/API range. Its release version SHALL be coordinated with the product release.

#### Scenario: Compatible extension loads
- **WHEN** a user explicitly installs the matching Pi extension package
- **THEN** Pi loads compiled extension code without referring to the SWF source checkout

#### Scenario: Extension and service are incompatible
- **WHEN** extension and service protocol ranges do not overlap
- **THEN** the extension reports actionable upgrade guidance rather than issuing unsupported mutations

### Requirement: Internal package encapsulation
Core and integration workspace packages SHALL remain private and be inlined into the product during assembly. The published manifest SHALL NOT declare any `workspace:` dependency or any unpublished internal package. No internal package SHALL be published merely because the product is distributed; public SDK packages require an explicit supported API contract.

#### Scenario: Product is packed
- **WHEN** the product artifact is assembled
- **THEN** all required internal code is available without resolving unpublished private workspace packages

#### Scenario: Manifest declares an unpublished internal package
- **WHEN** package verification finds a `workspace:` protocol dependency or an unpublished internal package in the published manifest
- **THEN** verification fails, because such a package cannot be installed by a consumer

### Requirement: Declared third-party dependencies
Third-party runtime dependencies SHALL be declared in the published manifest and resolved at installation rather than inlined into product files, so that dependency security patches reach existing installations without a SWF release. Every declared dependency SHALL be published and installable from the target registry.

#### Scenario: Dependency publishes a patch
- **WHEN** a declared dependency releases a compatible patch version
- **THEN** a new installation resolves the patched version without requiring a new SWF release

#### Scenario: Development-only tool is declared at runtime
- **WHEN** the published manifest declares a build- or development-only tool such as a TypeScript runner or bundler as a runtime dependency
- **THEN** package verification fails

### Requirement: Product licence
The product SHALL be distributed under the MIT licence. The repository SHALL contain a `LICENSE` file, the published package SHALL include it, and package manifests SHALL declare a matching licence identifier.

#### Scenario: Package is inspected
- **WHEN** the assembled package is verified
- **THEN** it contains the `LICENSE` file and its manifest declares the matching MIT identifier

#### Scenario: Licence metadata is missing or inconsistent
- **WHEN** the manifest licence identifier is absent or does not match the repository `LICENSE`
- **THEN** package verification fails
