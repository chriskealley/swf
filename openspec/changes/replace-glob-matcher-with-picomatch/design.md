## Context

`assessRiskOverride` in `packages/core/src/checks.ts` decides whether a run must stop for manual approval. One of its inputs is `sensitivePathPatterns`, matched against `changedFiles` by a private `matchesPattern` helper that compiles a glob to a regex by hand.

The helper is wrong. It escapes regex metacharacters, then runs `.replaceAll("**", ".*")` followed by `.replaceAll("*", "[^/]*")`. The second pass has no way to know the `*` in `.*` was emitted by the first pass, so it rewrites it. Every `**` becomes `.[^/]*`.

Verified against the production pattern list at `apps/service/src/server/swf-service.ts:3294`:

```
MATCH   **/security/**   src/security/token.ts        ^.[^/]*/security/.[^/]*$
MISS !  **/security/**   app/api/security/token.ts    ^.[^/]*/security/.[^/]*$
MISS !  **/security/**   security/token.ts            ^.[^/]*/security/.[^/]*$
MATCH   infra/**         infra/main.tf                ^infra/.[^/]*$
MISS !  infra/**         infra/aws/prod/main.tf       ^infra/.[^/]*$
MISS !  .github/**       .github/workflows/ci.yml     ^\.github/.[^/]*$
MATCH   **/auth/**       app/auth/login.ts            ^.[^/]*/auth/.[^/]*$
```

Only the accidental single-segment cases pass. The existing test (`packages/core/test/checks.test.ts:241`) uses exactly such a case, which is why this has stayed green.

Because `assessRiskOverride` returns a list of reasons and an empty list means "no override", a missed match fails **open**: the run auto-approves. That inverts the requirement's stated fail-closed intent.

## Goals / Non-Goals

**Goals:**
- Correct glob semantics for sensitive path rules, with `**` spanning path separators.
- Cover dotfile paths, since `.github/**` is one of the shipped defaults.
- Pin the behavior with tests over every shipped default pattern, so a future regression is caught.
- Define the semantics in the spec so "matches a sensitive path rule" is no longer ambiguous.

**Non-Goals:**
- Making the hard-coded pattern list in `swf-service.ts` project-configurable.
- Changing any other risk signal (`destructiveOperation`, `secretsFound`, `elevatedRisk`, budget thresholds).
- Introducing glob matching anywhere else in the codebase.
- Changing how `changedFiles` is produced by the git evidence collector.

## Decisions

### 1. Use `picomatch` rather than fixing the regex builder

The bug is a symptom: correct glob-to-regex compilation involves segment semantics, `**` collapsing, negation, brace expansion, and escaping interactions that are easy to get subtly wrong — as this code demonstrates. A one-line reordering fix would leave the next edge case unhandled.

`picomatch` is the matcher beneath `fast-glob`, `chokidar`, and much of the tooling ecosystem. It has no runtime dependencies and is the de facto reference for these semantics.

*Alternative considered:* fix the ordering with a single-pass tokenizer. Rejected — it keeps a security-relevant parser in-house for no benefit, and we would be reimplementing `picomatch` badly.

*Alternative considered:* `minimatch`. Functionally comparable; `picomatch` is faster and dependency-free, and is what most of the ecosystem now uses underneath.

### 2. Enable `dot: true`

`picomatch` defaults to `dot: false`, where `*` and `**` do not match path segments beginning with `.`. Under that default `.github/**` would still fail to match `.github/workflows/ci.yml` — swapping one silent miss for another, in the single most likely sensitive-path case.

Since these patterns are operator-authored risk rules over repository paths, a literal reading is correct: if someone writes `.github/**`, they mean everything under `.github`. We set `dot: true`.

*Alternative considered:* leave the default and require operators to write extra patterns. Rejected: it preserves the fail-open behavior for the exact case that motivated the change.

### 3. Precompile matchers per pattern

`assessRiskOverride` matches every changed file against every pattern — an O(files × patterns) loop. The current code constructs a fresh `RegExp` on every pair. We build one `picomatch` matcher per pattern up front and reuse it across files.

### 4. Fail closed on an unevaluable pattern

**Corrected during implementation.** This decision originally assumed `picomatch` throws on a malformed pattern. It does not. Verified behavior:

```
picomatch.parse("[unterminated") => output: "\[unterminated"
picomatch.parse("{unclosed")     => output: "(unclosed"
picomatch(undefined)             => throws "Expected pattern to be a non-empty string"
```

`picomatch` only throws for a non-string or empty pattern. For a malformed *string* it recovers by escaping the text to a literal, so `[unterminated` compiles to a rule matching only a file with that exact name — which will never fire. That is a silent, dead risk rule: precisely the fail-open failure mode this change exists to remove, reintroduced through a different door.

A `try/catch` alone therefore covers only the empty/non-string case. To honor the fail-closed requirement we additionally validate that glob delimiters (`[]`, `{}`, `()`) are balanced, respecting backslash escapes, before compiling. An unbalanced pattern is treated as unevaluable and matches everything, forcing manual approval.

*Alternative considered:* let malformed patterns compile to literals and accept the behavior. Rejected — it silently reintroduces the exact defect being fixed.

*Alternative considered:* validate patterns at config load and reject them loudly. Better long-term, but the pattern list is currently hard-coded rather than operator-supplied, so there is no load-time boundary to validate at. Revisit when the list becomes configurable.

*Trade-off accepted:* a file legitimately named `a[b.ts` used as a literal pattern would be flagged unevaluable and over-match. Over-matching errs toward requiring a human, which is the safe direction for this gate.

### 5. Accept the behavior change rather than gate it behind a flag

Fixing this makes more runs stop for approval. That is the correct behavior and the entire point, but it is a visible change for projects running autonomously with `sensitive-path` enabled.

We do not put it behind an opt-in flag: a fail-open security gate that must be opted into is not fixed. The change ships with a release note explaining that the rules were previously not matching as documented.

## Risks / Trade-offs

- **Operators see unexpected new approval stops** → Expected and correct. Mitigate with an explicit release note and by ensuring the gate's explanation names the specific rule and path that matched, so the stop is self-explaining rather than mysterious.
- **`dot: true` broadens matching more than some operators expect** → It matches the literal reading of the patterns, and the shipped defaults require it. Documented in the spec's requirement text.
- **Path separator mismatch on non-POSIX platforms** → `supportedPlatforms` is `["darwin", "linux"]` (`packages/core/src/requirements.ts:73`) and `changedFiles` comes from git, which emits forward slashes. Not a concern today; the spec states forward-slash repository-relative paths so the assumption is recorded.
- **Adding a dependency to `@swf/core`** → Mildly counter to the parallel effort to trim runtime dependencies. Justified: `picomatch` is dependency-free and small, and it removes hand-rolled security-relevant parsing. Correctness outweighs the footprint here.
- **Trailing-slash or leading-`./` forms in changed-file paths** → Normalize inputs before matching and cover it in tests.

## Migration Plan

1. Add `picomatch` and `@types/picomatch` to `packages/core/package.json`.
2. Add failing tests first, covering each shipped default pattern against multi-segment, root-level, nested, and dotfile paths — confirming they reproduce the documented misses.
3. Replace `matchesPattern` with a precompiled `picomatch` matcher using `{ dot: true }`, with fail-closed handling for uncompilable patterns.
4. Confirm the previously failing tests pass and the existing `infra/**` test still passes.
5. Run `pnpm check` and the full test suite.
6. Add a release note describing the behavior change for autonomous-mode projects.

**Rollback:** self-contained in one function plus its tests. Reverting restores prior behavior — including the fail-open bug, so rollback should be a last resort rather than a response to increased approval stops.

## Open Questions

- ~~Should the gate's explanation text name the matched pattern as well as the matched path?~~ **Resolved during implementation: yes, both.** The reason is now `sensitive path changed: <path> matches <pattern>`. Verified safe before changing it: risk reasons are free text, wrapped by the service as `Manual approval required: ${reason}` and joined into `gate.decided` event data, with no equality comparison anywhere in the codebase. Only the first match is named, to keep the message bounded on large diffs.
