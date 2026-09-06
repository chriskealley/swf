## Context

SWF is currently a private pnpm workspace. The CLI bin points to `src/main.ts` and runs through `tsx`; core and integration packages export TypeScript source; all workspace packages are private; the service launcher defaults to `pnpm --filter @swf/service dev`; and dashboard usage requires a Vite development server. There are no package content allowlists, publication metadata, release workflows, package provenance, GitHub product archives, repository licence, or clean-install smoke tests.

The live local-project exercise required a shell function around `pnpm --dir`, connected development code to the real user-scoped service, exposed HMR ownership issues, and did not exercise a production package. Productization must improve contributor iteration and consumer installation together so the exact artifact tested locally is the artifact published.

Constraints remain: loopback authenticated service, user/project state outside product files, explicit dependency and credential setup, explicit project trust, no silent service installation or migrations, and private operational permissions. The supported Node baseline rises to `>=24.0.0` for the distributed product; Node 24 is an active LTS line and a reasonable floor for a first release.

## Goals / Non-Goals

**Goals:**
- Provide a one-command checkout-local CLI and isolated development instances.
- Separate fast HMR development from production-like artifact preview.
- Ship compiled CLI, production service, dashboard, templates, and migrations without workspace assumptions.
- Verify clean installation and production behavior of the exact release artifact.
- Distribute through npm-compatible registries and GitHub releases.
- Support explicit production user-service installation and lifecycle on macOS and Linux.
- Handle CLI/service skew, migrations, upgrades, downgrade refusal, and uninstall without state loss.
- Produce auditable supply-chain evidence and gated releases.

**Non-Goals:**
- Publishing every internal workspace package as a supported SDK.
- Homebrew, APT, RPM, container, native Windows service, or curl-pipe installers in the initial release.
- Bundling third-party dependencies into product files; they are declared and installed so security patches reach existing installations.
- Bundling Node, Git, Herdr, Pi, OpenSpec, GitHub CLI, or optional harness executables into the product.
- Installing dependencies, credentials, remotes, services, trust, migrations, or cleanup silently.
- Replacing project-owned `.swf/` configuration during package upgrades.

## Decisions

### 1. Treat the assembled product as the release boundary

Internal workspace packages remain development boundaries. Release assembly produces one canonical product package and one Pi extension package.

```text
pnpm workspace
├── apps/cli
├── apps/service
├── apps/dashboard
├── packages/core
├── packages/integrations
└── extensions/pi
          │
          ▼ build + assemble
release staging
├── product package
│   ├── bin/swf.mjs
│   ├── service/server/index.mjs
│   ├── service/public/dashboard/*
│   ├── templates/*
│   ├── migrations/*
│   ├── package.json
│   ├── LICENSE
│   └── notices/SBOM metadata
└── Pi extension package
    ├── dist/index.mjs
    ├── package.json
    └── compatibility metadata
```

The product package **inlines internal SWF modules** and **declares third-party runtime dependencies** normally. This split is load-bearing rather than stylistic:

- `apps/cli`, `apps/service`, and `apps/dashboard` depend on `@swf/core` and `@swf/integrations` through the `workspace:*` protocol, and those packages are `private`. A published package that declared them would be uninstallable, because they do not exist on any registry. Inlining resolves this without publishing internal packages as an implied SDK.
- Third-party dependencies stay declared with their existing caret ranges. Consumers therefore receive dependency security patches without waiting for a SWF release. The cost is accepted explicitly in Risks below.

Nitro's production preset already emits a self-contained service output, so the service half is assembled independently of this decision. Task 2.3 verifies that empirically rather than assuming it.

Public SDK publication remains deferred until an explicit API support commitment exists.

Package names are resolved. The unscoped `swf` name is already taken on npm, so the product publishes under a scope:

```text
product        @chriskealley/swf
Pi extension   @chriskealley/swf-pi
binary         swf          (bin name is independent of package name)
repository     github.com/chriskealley/swf
```

Scoped packages default to restricted access; publication must set public access explicitly or the first publish fails.

### 2. Compile production entries and inline internal modules

The CLI bin targets compiled JavaScript with a Node shebang. It locates service, templates, migrations, dashboard, and version metadata relative to the installed product using module URLs rather than current working directory.

The Nitro service uses a production Node preset. Dashboard output is copied into the service's packaged public asset tree and served by the same loopback process, retaining authenticated API and browser security controls. `swf dashboard open` starts or locates the service and opens or prints its loopback URL.

External source maps ship in **both** channels. SWF writes durable evidence and audit records, so a stack trace that cannot be resolved to real source is a poor diagnostic for a failed run. Maps are emitted as separate `.map` files rather than inlined, so Node loads them only when an error formatter or debugger asks and package-size budgets stay meaningful. The usual argument for withholding source maps concerns web bundles served over a network; it does not apply to a local CLI whose repository is public.

Type declarations may be retained internally for build verification but are not an implied public SDK.

### 3. Introduce named isolated development instances

Development state lives below an ignored checkout directory by default:

```text
.swf-dev/<instance>/
├── service-home/
├── credential and metadata
├── projects.json
├── audit.jsonl
├── logs/
├── package/
└── instance.json
```

A development launcher selects an available loopback port, sets explicit SWF service/config homes, records the checkout commit and mode, and prints all paths. It never adopts `~/.config/swf` or port `34671` unless explicitly configured.

Commands conceptually include:

```text
pnpm dev --project <path> [--instance <name>]
pnpm preview --project <path> [--instance <name>]
pnpm dev:list
pnpm dev:stop --instance <name>
pnpm dev:clean --instance <name>
```

The exact script names may evolve, but the behavior must not require a shell function or global link. A generated checkout-local executable can call the current CLI while preserving the target cwd.

### 4. Separate fast development from production preview

Fast mode runs source-aware CLI and service/dashboard watchers with source maps. HMR is an optimization, not an authority boundary; unsafe module replacement triggers a controlled isolated-service restart.

Preview mode performs release assembly and runs only staged product entries:

```text
source checkout
    │
    ▼
build + assemble
    │
    ▼
install/stage exact product layout
    │
    ▼
compiled CLI → production service → packaged dashboard
```

Preview rejects runtime resolution to `src/*.ts`, `tsx`, pnpm workspace filters, Nitro dev, or Vite dev. It is the local bridge to release verification.

### 5. Make package verification install the exact tarball

Release assembly creates an npm-compatible tarball and product archive. Verification installs the tarball into a temporary prefix with isolated HOME, config, service home, endpoint, Git fixture, and package cache where practical. It invokes only the installed executable.

Smoke coverage includes:

- version and help;
- doctor without mutation;
- temporary committed Git/OpenSpec project initialization;
- production service start, health, authentication, query, graceful stop;
- packaged dashboard assets and browser security headers;
- private directory and file permissions;
- packaged templates and migrations;
- Pi extension package loading or static package validation;
- absence of workspace/source dependencies;
- state preservation after uninstall simulation.

Simulated adapters remain the default. Paid live harness execution is a separately authorized opt-in.

The verified artifact and checksum are promoted without rebuilding. npm publication and GitHub upload both refer to that identity.

### 6. Use a strict product manifest and package allowlist

Assembly starts from an empty staging directory and copies declared outputs. A generated manifest records path, size, mode, and SHA-256. Validation rejects unexpected or forbidden paths including credentials, `.swf-state`, `.swf-dev`, logs, coverage, arbitrary tests, development bundles, source-only files, and secret material.

`npm pack` inspection verifies bin targets, engine range, dependencies, license, repository, exports where supported, package size, and executable behavior. This is safer than relying only on `.npmignore` exclusions.

### 7. Launch the production service directly

Installed `swf service start` spawns the packaged Node service entry with argument-array APIs, detached when appropriate, private logs, and an explicit environment. It waits for metadata plus authenticated health/compatibility before reporting success. It does not invoke pnpm, Nitro CLI, or a shell.

Service metadata adds:

```text
product version
build/source identity
API protocol version
state schema version
compatible client range
service entry identity
managed-service mode
```

The CLI checks compatibility before mutation. Read-only diagnostics may remain available across a broader compatible range.

### 8. Make OS-managed service installation explicit

`swf service install` is preview-only by default. Confirmed application creates:

- a launchd user agent on macOS;
- a systemd user unit on Linux.

The plan shows absolute executable and Node paths, arguments, environment, log destinations, enablement, and startup behavior. Package installation itself never writes or starts these units.

The managed command uses a stable product launcher where the package manager can guarantee one. Diagnostics detect stale Node or package paths and produce a repair preview. Uninstall disables and removes only the owned unit and preserves all state.

Native Windows service integration is deferred.

### 9. Version CLI, service, API, state, and extension separately but release coherently

The product uses SemVer while compatibility is explicit:

```text
product version       1.2.0
API protocol          2
state schema          3
client range          >=1.1 <2
Pi extension range    >=1.2 <1.3
```

A package-manager file replacement does not migrate state or restart the service. The new CLI detects the old process and presents an ordered plan:

```text
install product
      │
      ▼
inspect CLI/service/state compatibility
      │
      ├── compatible, restart only
      ├── migration required: preview → backup → apply
      └── incompatible downgrade: refuse writer startup
```

Service upgrade drains active work unless force is explicitly authorized, starts the new entry, verifies handshake and health, and preserves diagnostics on failure. Existing migration backup/rollback remains authoritative.

### 10. Preserve state through uninstall

Package removal affects product files only. Project `.swf/`, project `.swf-state/`, user service home, credentials, registries, exports, logs, and audits remain. A stale managed unit is diagnosable and can be explicitly removed after reinstall or through package-manager-specific guidance.

Destructive cleanup is a separate previewed operation with scoped selections and confirmation. Service uninstall is not state uninstall.

### 11. Publish stable and next channels through gated automation

The product begins pre-1.0. Under SemVer, `0.y.z` permits breaking changes in a minor bump, which matches a product still settling its contracts. `1.0.0` is reserved for an explicit stability commitment.

Initial channels:

```text
stable: 0.2.0        → default registry tag, normal GitHub release
next:   0.3.0-next.2 → prerelease registry tag and GitHub prerelease
```

Publishing without an explicit prerelease tag makes a version the default install. Prerelease publication must therefore always pass its channel tag explicitly; this is a publication-time requirement, not a convention.

Release automation runs from protected trusted environments after all checks, package smoke tests, security validation, and explicit stable authorization. Untrusted pull requests never receive publishing credentials.

Release outputs include:

- npm-compatible product and Pi extension packages with provenance;
- immutable Git tag and GitHub product archive;
- checksums;
- release manifest/evidence;
- SBOM and dependency/license inventory;
- compatibility and migration notes.

Publication order matters. A registry version can never be republished once taken, while a Git tag can be deleted and re-cut. Registry publication therefore happens before tagging, so a failed publish never leaves a tag pointing at a version that does not exist.

The product is MIT licensed. Because third-party dependencies are installed rather than inlined, their licence files accompany them and no generated attribution bundle is required; the dependency/license inventory is retained for transparency and supply-chain evidence rather than to satisfy an attribution obligation.

### 12. Keep unsupported channels out of initial scope

Homebrew, APT/RPM repositories, containers, native Windows installation, and curl-pipe installers require separate design because each adds signing, update, filesystem, or runtime semantics. Documentation must not imply support before those contracts exist.

Homebrew is deferred rather than rejected. Its formulae must not fetch undeclared runtime code during installation, which conflicts with declaring third-party dependencies for install-time resolution; supporting it would require either a self-contained archive or a documented exception. Neither is worth carrying in a first release, and `homebrew-core` in any case expects an established project. npm-compatible installation covers the same users today.

## Risks / Trade-offs

- **Inlining internal packages can enlarge artifacts** → Measure package contents and size, tree-shake where safe, and retain a strict allowlist.
- **Declared dependencies float, so an installation may not match the verified artifact** → Accepted deliberately in exchange for security patches reaching installations without a SWF release. The verified checksum covers product files only; the resolved dependency closure is explicitly outside the artifact identity and is documented as such. Diagnostics should be able to report the resolved closure when a defect cannot be reproduced.
- **A published version can never be reused** → Registries refuse republication of an existing version, so a broken release can only be superseded. Package verification runs before publication, and publication precedes tagging.
- **Nitro output may contain environment-specific assumptions** → Smoke the staged production server in clean prefixes and multiple supported platforms.
- **Global Node package paths vary by manager** → Resolve assets relative to the executable/package and diagnose managed-unit paths explicitly.
- **Development launcher complexity can become another product** → Keep instance metadata simple, local, inspectable, and scoped to lifecycle essentials.
- **HMR can conflict with sole-writer guarantees** → Isolate instances and prefer controlled restart when stateful module replacement is unsafe.
- **Exact artifact promotion complicates CI stages** → Store immutable workflow artifacts with checksums and promote them through protected jobs.
- **Package uninstall cannot run reliable cleanup hooks** → Preserve state by default and provide explicit service and state cleanup commands.
- **CLI/service skew can confuse users** → Handshake before mutations and render exact restart/migration guidance.
- **Managed service paths can become stale after upgrades** → Use stable launchers where possible and provide previewed repair/reinstall.
- **Registry package naming may be unavailable** → Resolved: `swf` is taken, so the product publishes as `@chriskealley/swf`. Reserve both names before publication tasks finalize.
- **Supply-chain metadata adds release cost** → Automate manifests, provenance, SBOM, and checksums from one verified artifact pipeline.

## Migration Plan

1. Add version/build/protocol metadata and compile production CLI entries while retaining source scripts for development.
2. Add deterministic staging layout, strict manifest, production Nitro/dashboard assets, and local preview.
3. Add isolated development instances and remove the shell-function requirement from contributor documentation.
4. Add tarball installation smoke tests and package-content verification.
5. Add direct production service launch, compatibility handshake, logs, and dashboard-open behavior.
6. Add separately packed Pi extension and compatibility validation.
7. Add previewed launchd/systemd user-service installation and removal.
8. Select and reserve package names, add protected release workflows, and publish `next` artifacts first.
9. Validate npm/pnpm global installation and GitHub archives on a machine without the source checkout.
10. Promote to stable only after clean-install and upgrade/downgrade acceptance evidence is retained.

Rollback keeps source-based development available while packaged paths mature. Package publication can be stopped without deleting user state. A failed service upgrade leaves the old version or an actionable stopped state according to the reviewed plan.

## Open Questions

- ~~What canonical npm scope/name and Homebrew tap are available?~~ **Resolved.** `swf` is already published by another author, so the product is `@chriskealley/swf` and the extension `@chriskealley/swf-pi`. Homebrew is out of initial scope (Decision 12).
- ~~Should source maps ship in `next` only, or in stable too?~~ **Resolved: both channels**, as external `.map` files (Decision 2).
- ~~Should the dashboard root require the bearer credential, or serve static shell assets before authenticated API connection?~~ **Resolved: serve the static shell unauthenticated and authenticate every API route.** The shell must load before it can authenticate. `swf dashboard open` mints a short-lived single-use bootstrap token and passes it in the URL **fragment**, which the browser never transmits in the request line or `Referer` and which never reaches server logs; the dashboard exchanges it for a session credential held in memory and clears the fragment. Manual credential entry remains available for remote or headless use. The session credential must not be written to `localStorage`.
- ~~Should release archives bundle production dependencies?~~ **Resolved: no.** Internal workspace packages are inlined; third-party dependencies are declared and resolved at install (Decision 1).
- **Still open:** which Node installation paths are sufficiently stable for managed units across nvm, mise, asdf, Homebrew, pnpm, and npm installations? This needs empirical testing rather than a decision. Task 8.3's stale-path diagnostics matter more than selecting one correct answer up front.
