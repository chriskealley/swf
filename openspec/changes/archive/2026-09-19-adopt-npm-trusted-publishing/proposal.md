# Proposal

## Why

SWF's release workflow already requests an OIDC identity for provenance, but
registry authentication still depends on a long-lived `NPM_TOKEN`. npm trusted
publishing can bind publication to the protected GitHub workflow itself,
removing a reusable credential without weakening SWF's existing verification,
approval, promotion, or publish-before-tag guarantees.

This change delivers roadmap item RM-008.

## What Changes

- Configure the existing manually dispatched `release.yml` workflow to use an
  npm CLI version that supports trusted publishing and publish both verified
  tarballs through GitHub Actions OIDC without `NODE_AUTH_TOKEN`.
- Preserve the protected `release` environment, explicit stable approval,
  exact-artifact promotion, explicit registry tags, product-before-extension
  publication, publish-before-Git-tag ordering, and GitHub release evidence.
- Strengthen the static release audit and tests so a publishing workflow fails
  validation if it references a long-lived npm publication secret, lacks the
  required trusted-publishing npm baseline, or weakens the existing trust
  boundary.
- Document the per-package npm trusted-publisher configuration required for
  `@chriskealley/swf` and `@chriskealley/swf-pi`, including the repository,
  workflow filename, protected environment, and allowed publish action.
- Update release and distribution guidance to distinguish short-lived OIDC
  credentials from prohibited long-lived publication tokens and to retain a
  fail-closed recovery path for incomplete two-package publication.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-distribution`: require workflow-bound OIDC trusted publishing for
  registry mutation, prohibit long-lived npm write tokens in release
  automation, and retain provenance and protected-environment guarantees.

## Impact

- Affects `.github/workflows/release.yml`, release-policy auditing and unit
  tests under `packages/dev`, and release/distribution documentation.
- Requires trusted-publisher entries on npmjs.com for both public packages;
  those external settings are deployment prerequisites and are not created by
  repository automation.
- Requires npm `>=11.5.1` in the publication job while leaving the product's
  Node.js and package-manager compatibility unchanged.
- Does not add a second publish workflow, change release triggers, rebuild
  promoted artifacts, change package contents, or publish a version as part of
  implementation.
