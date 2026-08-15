## Why

The sensitive-path risk override in `packages/core/src/checks.ts` is silently broken. `matchesPattern` builds a regex by chaining two replacements:

```ts
pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  .replaceAll("**", ".*")
  .replaceAll("*", "[^/]*")
```

The second `replaceAll` re-processes the `*` inside the `.*` that the first one just produced, so every `**` degrades to `.[^/]*` — "exactly one character, then a single path segment". The result is that `**` cannot span path separators at all, which is the entire reason to write `**`.

This is not theoretical. The four sensitive-path patterns hard-coded at `apps/service/src/server/swf-service.ts:3294` are `[".github/**", "**/security/**", "**/auth/**", "infra/**"]`, and **all four fail on realistic paths**:

| Pattern | Path | Generated regex | Result |
|---|---|---|---|
| `.github/**` | `.github/workflows/ci.yml` | `^\.github/.[^/]*$` | **MISS** |
| `infra/**` | `infra/aws/prod/main.tf` | `^infra/.[^/]*$` | **MISS** |
| `**/security/**` | `app/api/security/token.ts` | `^.[^/]*/security/.[^/]*$` | **MISS** |
| `**/security/**` | `security/token.ts` | `^.[^/]*/security/.[^/]*$` | **MISS** |

The existing test at `packages/core/test/checks.test.ts:241` uses `infra/**` against a single-segment path, which happens to be the one shape that still matches — so the suite is green while the gate is broken.

The consequence is a fail-**open** security gate: `assessRiskOverride` returns no `sensitive path changed` reason, so a run that modifies CI workflows, infrastructure, or auth code auto-approves under autonomous mode instead of waiting for a human. This directly contradicts the `checks-and-gates` requirement that risk overrides fail closed.

## What Changes

- Replace the hand-rolled `matchesPattern` in `packages/core/src/checks.ts` with `picomatch`, the matcher underlying most of the JS glob ecosystem.
- Fix the sensitive-path override so `**` correctly spans path separators and matches zero or more segments, including at the start or end of a pattern.
- Add regression tests covering every hard-coded default pattern against multi-segment, root-level, and nested paths — the cases that currently fail.
- Configure `picomatch` with `dot: true` so dotfile paths such as `.github/workflows/ci.yml` are matched. This is required for correctness here: the default `dot: false` would keep `.github/**` broken, replacing one silent miss with another.
- **BREAKING (behavioral, intended)**: patterns that previously failed to match now match. Runs touching sensitive paths will correctly stop for manual approval where they previously auto-approved. This is the fix, but it will change autonomous-mode behavior for existing projects and must be called out in release notes.

## Capabilities

### New Capabilities

None. This change corrects an existing capability rather than adding one.

### Modified Capabilities

- `checks-and-gates`: the `Risk and fail-closed overrides` requirement gains explicit, testable glob semantics for sensitive path rules. The requirement currently says only that the gate triggers when "the diff matches a configured sensitive path rule" without defining what matching means — the ambiguity that let a broken matcher pass review. The modified requirement states that `**` spans path separators, that matching is fail-closed, and that dotfile paths are in scope.

## Impact

- **Code**: `packages/core/src/checks.ts` (`matchesPattern`, consumed by `assessRiskOverride`); `packages/core/test/checks.test.ts` (extend coverage).
- **Dependencies**: adds `picomatch` (plus `@types/picomatch`) to `@swf/core`. It is a widely used, zero-runtime-dependency matcher.
- **Behavior**: approval decisions change for projects with `sensitive-path` in `policy.riskOverrides`. More runs will correctly require manual approval. Operators may perceive this as new friction; the release note must explain that the gate was previously not firing.
- **Security**: closes a fail-open gap in a gate whose stated purpose is to fail closed.
- **Out of scope**: the hard-coded pattern list at `swf-service.ts:3294` remains hard-coded. Making it project-configurable is a separate change; this one only makes the existing patterns work as written.
