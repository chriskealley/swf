# Design

## Context

See proposal.md - Why. The current `.github/workflows/release.yml` already has
the trust boundary this change builds on: manual dispatch from protected
`main`, a `verify` job that produces the only artifacts that will ever be
published, and a `publish` job gated on the protected `release` environment
with `id-token: write` for provenance. The single remaining long-lived
credential is `secrets.NPM_TOKEN`, exported as `NODE_AUTH_TOKEN` on both
publish steps.

Two constraints shape the approach:

- `actions/setup-node@v5` with `registry-url` writes an `.npmrc` that expects
  `NODE_AUTH_TOKEN`. npm resolves trusted publishing only when no auth token is
  configured for the registry, so the token wiring must be removed rather than
  left empty.
- Trusted publishing requires npm `>=11.5.1`. The npm bundled with the pinned
  Node 24 toolchain is not guaranteed to meet that floor, so the publish job
  must install a qualifying npm explicitly rather than rely on the runtime.

The static audit in `packages/dev/src/release-policy.ts` (`auditReleaseWorkflow`,
run on pull requests via `pnpm verify:release-guard`) is what keeps the trust
boundary from regressing. It currently has no opinion about how publication
authenticates, so it would not notice a token being reintroduced.

## Goals / Non-Goals

**Goals:**

- Publish both packages with no npm credential stored anywhere in the
  repository or its environments.
- Make the absence of a long-lived publication token a statically enforced
  property, not a convention.
- Keep every existing ordering and approval guarantee byte-for-byte intact.

**Non-Goals:**

- Changing release triggers, adding a second publishing workflow, or altering
  what the `verify` job builds.
- Automating the registry-side trusted-publisher setup; that is an operator
  prerequisite performed on npmjs.com.
- Publishing a version as part of implementing this change.

## Decisions

**Remove `registry-url` from `setup-node` instead of clearing `NODE_AUTH_TOKEN`.**
Leaving `registry-url` in place generates an `.npmrc` with an `_authToken`
line referencing an unset variable, which npm treats as a configured (and
empty) credential and which suppresses the trusted-publishing path. Dropping
the input leaves the default public registry with no auth entry, which is the
state trusted publishing requires. Alternative considered: keep `registry-url`
and delete the generated `.npmrc` before publishing - equivalent in effect but
depends on an undocumented file path.

**Install npm explicitly in the publish job (`npm install -g npm@^11.5.1`).**
This pins the capability the workflow depends on rather than the incidental
npm bundled with the Node version, and gives the audit a concrete token to
match on. Alternative considered: `corepack`-managed npm - unnecessary, since
pnpm is the project's package manager and npm is used only as the publish
client.

**Enforce tokenlessness in `auditReleaseWorkflow` rather than a new checker.**
The existing audit already encodes the release trust boundary and already runs
on untrusted pull requests, which is exactly when a reintroduced credential
must be caught. Two checks are added, both conditional on the workflow being a
publishing workflow: the source must not reference a long-lived npm publication
secret (`NPM_TOKEN`-shaped secret references or a `NODE_AUTH_TOKEN`/`_authToken`
assignment), and it must set up npm at or above the trusted-publishing floor.
Detection is textual because the audit deliberately inspects workflow source
rather than a running workflow.

**Keep `--provenance` explicit on both publish commands.** Trusted publishing
can imply provenance, but the channel policy in `release-policy.ts` treats
provenance as a hard requirement for both channels, and an explicit flag keeps
the workflow's guarantee legible and independent of npm's defaults.

**Treat the registry trusted-publisher entries as documented prerequisites.**
Both packages need an entry naming this repository, `release.yml`, and the
`release` environment. The environment is optional on npm's side but is set
deliberately: it is what binds publication to the approval gate, so that a run
of `release.yml` that never entered the protected environment cannot publish.
Documenting the entries in `docs/releasing.md` keeps the setup reproducible;
the existing fail-closed recovery path already covers the case where the first
package publishes and the second is rejected.

**Allow the `npm publish` action rather than adopting staged publishing.**
A trusted publisher's allowed actions always permit `npm stage publish`;
`npm publish` is the optional one, and configurations created after
2026-09-03 default to staged-only. Staged publishing is the more restrictive
option, but it inverts this workflow's central guarantee: a staged package is
pending approval rather than live, so the workflow would push the Git tag and
create the GitHub release while nothing was published. Adopting it would mean
restructuring the publish job around an out-of-band approval, which is out of
scope here, and the protected `release` environment already provides a human
gate. So `npm publish` must be enabled on both packages' configurations.

**Disallow tokens at the registry only after a tokenless release succeeds.**
Removing the workflow's token wiring stops this repository using a long-lived
credential, but it does not stop one being minted and used elsewhere. Each
package's Settings -> Publishing access offers "Require two-factor
authentication and disallow tokens", which closes that path while leaving
OIDC trusted publishing working. Sequencing it after a proven release keeps a
rollback available during the migration itself.

## Risks / Trade-offs

- **A misconfigured or missing trusted publisher fails the first real release,
  and if it fails on the second package the two packages are left out of step.**
  → The existing `rollbackPlan` path for partial publication already handles
  this, and publication still precedes tagging, so no tag points at an
  unpublished version. The documented prerequisite makes the setup checkable
  before dispatch.
- **Textual auditing can be evaded or can produce false positives** (for
  example a comment mentioning `NPM_TOKEN`). → Accepted: the audit is a
  regression guard over a file that changes rarely and is reviewed, and the
  same trade-off already applies to every other check it performs.
- **Pinning npm to `^11.5.1` adds a step that can break if the npm major
  changes.** → The floor is a range, not an exact pin, and the audit reports a
  clear reason if the baseline is ever dropped.
- **No end-to-end rehearsal is possible without publishing a version.** →
  Verification is limited to the static audit, unit tests, and a `next`-channel
  release being the first real exercise of the path.

## Migration Plan

1. Register the trusted publisher for `@chriskealley/swf` and
   `@chriskealley/swf-pi` on npmjs.com (repository, `release.yml`, `release`
   environment). This must precede the first dispatch after the workflow change.
2. Merge the workflow, audit, test, and documentation changes.
3. Exercise the path with a `next`-channel release before the next stable one.
4. Revoke the existing `NPM_TOKEN` secret once a release has published without
   it, and set each package's publishing access to require two-factor
   authentication and disallow tokens. Rollback before step 4 is restoring the
   token wiring; after step 4 it requires re-enabling token publishing and
   minting a new token, which is the intended direction of travel.
