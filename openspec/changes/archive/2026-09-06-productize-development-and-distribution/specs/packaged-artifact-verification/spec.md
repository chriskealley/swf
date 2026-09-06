## ADDED Requirements

### Requirement: Deterministic artifact assembly
Release tooling SHALL build from a clean identified Git commit, assemble a staging layout, validate manifests and generated assets, and produce versioned package and archive artifacts with checksums. The artifact identity SHALL include version and source commit.

#### Scenario: Working tree is dirty
- **WHEN** a stable release is requested from a dirty or mismatched checkout
- **THEN** assembly refuses publication or requires an explicitly non-publishable development artifact label

#### Scenario: Build is repeated
- **WHEN** the same source, toolchain, lockfile, and release inputs are assembled twice
- **THEN** release tooling reports whether checksums match and identifies known nondeterministic metadata if they do not

### Requirement: Pack and inspect before publish
The npm-compatible package SHALL be packed locally and its exact contents, metadata, executable modes, dependency set, engine constraints, license, and size SHALL be verified before any registry publication.

#### Scenario: Unexpected file enters package
- **WHEN** package inspection finds a file outside the allowlist
- **THEN** verification fails and publication is not attempted

#### Scenario: Binary target is invalid
- **WHEN** the package's `bin` target is missing, non-executable where required, or points to TypeScript source
- **THEN** verification fails

### Requirement: Clean temporary installation
The exact packed artifact SHALL be installed into a temporary package prefix and isolated HOME/config/state directories using a compatible Node runtime. Smoke tests SHALL invoke only the installed artifact.

#### Scenario: Global-style smoke test
- **WHEN** package verification runs
- **THEN** the temporary `swf` executable resolves no modules or assets from the source workspace

#### Scenario: Existing user state exists
- **WHEN** verification runs on a contributor machine
- **THEN** temporary installation and service tests do not read or modify the contributor's real SWF metadata, credentials, registry, or service

### Requirement: Production smoke coverage
Artifact smoke tests SHALL cover version/help, doctor, temporary Git project initialization, production service start/health/authenticated query/stop, packaged dashboard assets, private permissions, and Pi extension loadability. Live harness execution remains a separate explicit opt-in.

#### Scenario: Production service smoke test
- **WHEN** the packed artifact is verified
- **THEN** its compiled service starts on an isolated endpoint, authenticates a query, and shuts down without a source checkout

#### Scenario: Dashboard asset is missing
- **WHEN** the packaged service cannot serve the expected dashboard entry and static assets
- **THEN** artifact verification fails

### Requirement: Exact artifact promotion
Registry publication and GitHub release upload SHALL refer to the exact artifact checksums that passed package verification. Release jobs SHALL NOT rebuild different product archives after approval.

#### Scenario: Promoted checksum differs
- **WHEN** a publication candidate differs from the verified checksum
- **THEN** promotion stops and requires a new verification run

### Requirement: Dependency closure is outside artifact identity
Verified artifact identity SHALL cover product files only. Third-party dependencies are declared with version ranges and resolved at installation, so an installed dependency closure MAY differ from the closure present during verification. This boundary SHALL be stated explicitly in release documentation rather than left implied, and diagnostics SHALL be able to report the resolved closure of a running installation.

#### Scenario: Checksum scope is inspected
- **WHEN** an operator verifies a published artifact against its checksum
- **THEN** the checksum validates the product package contents and does not assert which third-party dependency versions were installed alongside it

#### Scenario: Installation resolves newer dependencies
- **WHEN** a user installs a published version after a dependency has released a compatible patch
- **THEN** installation succeeds with the newer dependency and the product remains the verified artifact

#### Scenario: Defect cannot be reproduced
- **WHEN** reported behavior cannot be reproduced against the verified artifact
- **THEN** diagnostics can report the resolved dependency closure so version drift can be identified

### Requirement: Release evidence
Each release SHALL retain a machine-readable manifest containing source commit, version, toolchain, lockfile identity, package contents, checksums, tests, provenance references, SBOM reference, and publication destinations.

#### Scenario: Release is audited
- **WHEN** an operator inspects a published version
- **THEN** they can trace it to the verified source commit and artifact evidence without relying on mutable CI logs alone
