# Tasks

## 1. Workflow

- [ ] 1.1 Remove `registry-url` from the publish job's `actions/setup-node` step and delete both `NODE_AUTH_TOKEN`/`secrets.NPM_TOKEN` environment entries, verifying `.github/workflows/release.yml` no longer matches a grep for `NPM_TOKEN` or `NODE_AUTH_TOKEN`
- [ ] 1.2 Add a publish-job step that installs npm at the trusted-publishing baseline (`npm install -g npm@^11.5.1`) before the promotion check, verifying the step precedes both publish steps in the job's step order
- [ ] 1.3 Confirm both publish steps still pass `--provenance` and an explicit `--tag "$REGISTRY_TAG"` against `"dist/release/$TARBALL"`, and that publication still precedes the Git tag and GitHub release

## 2. Static release audit

- [ ] 2.1 Extend `auditReleaseWorkflow` in `packages/dev/src/release-policy.ts` so a publishing workflow referencing a long-lived npm publication secret (an `NPM_TOKEN`-shaped `secrets.` reference, a `NODE_AUTH_TOKEN` assignment, or an `_authToken` entry) reports a violation naming the prohibited credential
- [ ] 2.2 Extend `auditReleaseWorkflow` so a publishing workflow that does not set up npm at or above the trusted-publishing minimum reports a violation naming the unmet baseline
- [ ] 2.3 Run `pnpm verify:release-guard` and verify it passes against the updated `release.yml` and reports the new violations against a workflow that reintroduces a token

## 3. Tests

- [ ] 3.1 Add cases to `packages/dev/test/release-policy.test.ts` covering: a tokenless trusted-publishing workflow auditing clean, a workflow with `NODE_AUTH_TOKEN`/`secrets.NPM_TOKEN` failing, and a workflow without the npm baseline failing
- [ ] 3.2 Add a case asserting the existing trust-boundary checks (protected environment, OIDC permission, dispatch from main, exactly two tarball publications, publish-before-tag) still fail when weakened, verifying `pnpm test` passes

## 4. Documentation

- [ ] 4.1 Document in `docs/releasing.md` the per-package npm trusted-publisher configuration for `@chriskealley/swf` and `@chriskealley/swf-pi` as an operator prerequisite, recording the exact values: provider GitHub Actions, organization `chriskealley`, repository `swf`, workflow filename `release.yml`, environment `release`, and allowed actions including `npm publish`
- [ ] 4.2 Document in `docs/releasing.md` that allowed actions must include `npm publish`, because trusted-publisher configurations created after 2026-09-03 default to `npm stage publish` only, which would fail the workflow's direct publish and would cut the Git tag while the packages were still unpublished
- [ ] 4.3 Document in `docs/releasing.md` the post-migration hardening step: after a release has published tokenlessly, revoke the `NPM_TOKEN` secret and set each package's Settings → Publishing access to “Require two-factor authentication and disallow tokens”, noting that this affects only traditional token authentication and leaves OIDC trusted publishing working
- [ ] 4.4 Update `docs/releasing.md` and `docs/distribution.md` to describe publication as authenticated by short-lived workflow OIDC with no long-lived npm token, including the updated `verify:release-guard` checks and the retained fail-closed recovery path for incomplete two-package publication

## 5. Validation

- [ ] 5.1 Run `pnpm check` and `pnpm test` and verify both pass
- [ ] 5.2 Run `openspec validate adopt-npm-trusted-publishing --strict` and verify the change is valid
