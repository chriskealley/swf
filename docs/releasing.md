# Releasing

SWF publishes to npm and GitHub. Homebrew, APT, RPM, containers, and curl installers are out of scope.

The package layout, checksum boundary, and evidence files are described in
[Package contents and verification](./distribution.md). Contributor fast mode,
production-like preview, and non-publishing verification are described in
[Contributor development](./development.md).

## Channels

| Channel  | Version shape  | Registry tag | GitHub     | Authorization     |
| -------- | -------------- | ------------ | ---------- | ----------------- |
| `stable` | `0.1.0`        | `latest`     | release    | explicit approval |
| `next`   | `0.2.0-next.1` | `next`       | prerelease | not required      |

Releases begin pre-1.0. Under SemVer a `0.y.z` minor increment may introduce breaking changes, and release notes must say so when it does. `1.0.0` is reserved for an explicit stability commitment.

Git tags are `v<version>`. Both packages — the product and the Pi extension — release together at the same version, so a user can pair them by version alone.

## The one irreversible step

A registry version can never be reused. npm's unpublish window is narrow and the version is burned regardless, so a broken release can only be superseded, never replaced.

Everything else is recoverable: a Git tag can be deleted and re-cut, a GitHub release can be edited, a dist-tag can be moved.

Publication therefore happens **before** tagging. A failed publish then leaves no tag pointing at a version that does not exist.

Dispatch the workflow from the protected `main` branch with the exact version
already declared in `package.json`:

```sh
gh workflow run release.yml --ref main -f version=0.1.0 -f channel=stable
```

The workflow refuses a prefixed version, a version that differs from the
package, an existing tag, an unprotected branch, or a dispatch from any branch
other than `main`.

```
1. pnpm verify:release --channel=<channel>   # verify the exact artifact
2. npm publish --tag <latest|next> --provenance   # product      [irreversible]
3. npm publish --tag <latest|next> --provenance   # Pi extension [irreversible]
4. git tag v<version> && git push origin v<version>
5. gh release create v<version> [--prerelease] …
```

The registry tag is always explicit. Publishing a prerelease without `--tag next` would make it the default install for everyone.

## Trust boundary

Two workflows, with a deliberate split:

- **`verify.yml`** runs on every push and pull request, including forks. It has read-only permissions and references no secret, so untrusted code cannot reach a publication credential.
- **`release.yml`** runs only by explicit dispatch from protected `main`, enters the protected `release` environment before credentials are available, and is the only workflow that can publish or create a release tag.

`pnpm verify:release-guard` audits the workflows statically on every pull request. It fails if a pull-request-triggered workflow gains a secret or publish command, if publication is not manually dispatched from `main`, if a publishing workflow lacks a protected environment or OIDC permission, if it publishes anything other than the two verified tarballs, or if either registry publication can occur after Git tagging.

## Promotion, not rebuilding

The publication job downloads the artifact that passed verification and publishes those tarballs directly. `pnpm verify:promotion` re-hashes each tarball against the digests recorded at verification time and refuses promotion on any mismatch, so what reaches the registry is exactly what was tested. Only after both package publications succeed does the workflow create and push `v<version>`; the GitHub release then requires that existing tag.

## Release evidence

Before verification, write the human-reviewed notes at
`docs/releases/<version>.md`. The verifier requires the version heading plus
compatibility, upgrade/downgrade and state, known-limitations, and verification
sections; it rejects unfinished `TODO` or `TBD` markers. It copies those exact
notes to `dist/release/release-notes.md`, so the GitHub release cannot be
created from notes that were added after artifact verification.

Each verified release writes to `dist/release/`:

| File                    | Contents                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `release-evidence.json` | source commit, toolchain, lockfile digest, artifact digests, every smoke result, destinations |
| `sbom.json`             | CycloneDX bill of materials from the resolved dependency closure                              |
| `checksums.txt`         | `sha256sum`-compatible digests for both tarballs                                              |
| `promotion.json`        | the digests publication must match                                                            |
| `release-notes.md`      | the reviewed, version-specific notes used for the GitHub release                              |
| `*.tgz`                 | the verified artifacts themselves                                                             |

The **resolved dependency closure is recorded but is not part of artifact identity**. The product declares version ranges, so a user installing later may resolve different versions; recording the closure makes that drift diagnosable when a defect cannot be reproduced.

## If publication fails part way

Nothing overwrites a published version.

- **Product published, extension not**: publish the matching extension, or move the dist-tag back until it exists. Consumers must never pair mismatched versions.
- **A previous stable release must become the default again**: `npm dist-tag add @chriskealley/swf@<previous> latest`.
- **A tag exists for a version that was never published**: delete the tag and re-cut it after a successful publish.
- **A published version is broken**: release a superseding version. The broken one stays published and must not be reused.
