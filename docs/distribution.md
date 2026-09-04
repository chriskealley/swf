# Package contents and verification

SWF has two public release artifacts:

| Package                | Purpose                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `@chriskealley/swf`    | Compiled CLI, production service, packaged dashboard, metadata, and runtime defaults |
| `@chriskealley/swf-pi` | Compiled Pi extension with compatible service/API metadata                           |

They are released at the same version. Internal `@swf/*` workspace packages
remain private and are inlined where required; they are not public SDKs.

## Product boundary

Assembly starts from an empty staging directory and admits only the declared
product layout. The product contains compiled JavaScript entries, the Nitro
production service, built dashboard assets, product/compatibility metadata,
source maps selected by policy, and the MIT `LICENSE`. The Pi package contains
its compiled extension, compatibility metadata, manifest, source map, and
license.

Verification rejects TypeScript runtime entries, `workspace:` dependencies,
private package dependencies, build-only runtime tools, credentials,
`.swf-state`, `.swf-dev`, logs, coverage, arbitrary fixtures, and unrelated
repository output. A generated manifest records each admitted path, byte size,
mode, and SHA-256 digest.

Third-party runtime dependencies are deliberately declared rather than
inlined. This allows a later installation to receive compatible dependency
security patches. Consequently, the product checksum identifies the SWF
tarball—not every dependency version a package manager may later resolve.

## Verification pipeline

`pnpm verify:release --channel=development` performs the publication pipeline
without publishing:

1. Assemble and inspect the product and Pi-extension staging directories.
2. Pack both npm tarballs and inspect their contents and metadata.
3. Rebuild and compare source-derived file digests for reproducibility.
4. Install the exact product tarball into an isolated global-style prefix.
5. Smoke version/help, diagnostics, initialization, service health and
   authentication, dashboard assets, permissions, Pi loading, and uninstall
   state preservation without resolving from the checkout.
6. Copy the verified tarballs and reviewed release notes into `dist/release/`.
7. Write checksums, promotion metadata, the SBOM, and release evidence.

Stable verification refuses a dirty checkout. Development verification records
dirty state and is explicitly non-publishable.

## Release evidence

| File                    | Meaning                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `*.tgz`                 | Exact product and Pi artifacts promoted to npm and GitHub                                                      |
| `checksums.txt`         | SHA-256 identities for both tarballs                                                                           |
| `promotion.json`        | Digests that publication must match without rebuilding                                                         |
| `release-evidence.json` | Source, toolchain, lockfile, artifacts, smoke checks, dependency closure, provenance context, and destinations |
| `sbom.json`             | CycloneDX dependency and licence inventory                                                                     |
| `release-notes.md`      | Reviewed version-specific notes used by the GitHub release                                                     |

`pnpm verify:promotion` re-hashes the candidates immediately before
publication. npm provenance is produced in the protected GitHub Actions release
environment using OIDC. Release secrets are unavailable to pull-request
verification jobs.

## Supported distribution channels

The supported initial channels are npm-compatible package managers and the
verified tarballs attached to GitHub releases. Stable releases use npm's
`latest` tag; prereleases use the explicit `next` tag and a GitHub prerelease.

The following are **unsupported in the initial release**: Homebrew, APT, RPM,
container images, native Windows service installation, and curl-pipe
installers. Native Windows execution is preview-only because Herdr's native
Windows support is preview. These channels require separate specifications and
must not be inferred from the npm or GitHub artifacts.

See [Releasing](./releasing.md) for authorization, ordering, rollback, and
partial-publication procedures, and [Installation](./installation.md) for npm,
pnpm, and GitHub archive commands.
