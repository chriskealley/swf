## 1. Reproduce the defect

- [x] 1.1 Add failing tests in `packages/core/test/checks.test.ts` asserting `assessRiskOverride` records a sensitive-path reason for `.github/**` vs `.github/workflows/ci.yml`
- [x] 1.2 Add failing tests for `infra/**` vs `infra/aws/prod/main.tf` (nested, multi-segment)
- [x] 1.3 Add failing tests for `**/security/**` vs both `app/api/security/token.ts` and root-level `security/token.ts`
- [x] 1.4 Confirm the existing `infra/**` single-segment test at line 241 still passes, establishing the regression baseline

## 2. Add the dependency

- [x] 2.1 Add `picomatch` and `@types/picomatch` to `packages/core/package.json` and refresh the lockfile
- [x] 2.2 Confirm `picomatch` resolves with no transitive runtime dependencies

## 3. Replace the matcher

- [x] 3.1 Replace the body of `matchesPattern` in `packages/core/src/checks.ts` with `picomatch` configured `{ dot: true }`
- [x] 3.2 Precompile one matcher per pattern in `assessRiskOverride` and reuse it across changed files instead of recompiling per pair
- [x] 3.3 Normalize changed-file paths (strip a leading `./`, strip trailing slashes) before matching
- [x] 3.4 Wrap pattern compilation so an uncompilable pattern records a sensitive-path reason (fail closed) instead of throwing or being skipped
- [x] 3.5 Remove the now-unused hand-rolled regex construction
- [x] 3.6 Add balanced-delimiter validation, since picomatch escapes malformed patterns to literals rather than throwing (see design decision 4)

## 4. Complete test coverage

- [x] 4.1 Confirm all tests from group 1 now pass
- [x] 4.2 Add a test that a single `*` does not span path separators (`infra/*` must not match `infra/aws/prod/main.tf`)
- [x] 4.3 Add a test for the fail-closed path using a deliberately malformed pattern
- [x] 4.4 Add a test asserting non-matching paths still produce no sensitive-path reason, guarding against over-matching
- [x] 4.5 Add a test covering all four shipped defaults from `swf-service.ts:3294` as a single pattern set
- [x] 4.6 Add a test that well-formed patterns containing `{}`, `[]`, and escaped brackets still evaluate normally

## 5. Verify and document

- [x] 5.1 Run `pnpm test:unit` and `pnpm test:integration` and confirm all suites pass
- [x] 5.2 Run `pnpm check` and confirm format, lint, and typecheck are clean
- [x] 5.3 Confirm the gate explanation names the matched rule and path so the approval stop is self-explaining
- [x] 5.4 Add a release note recording that sensitive-path rules previously failed to match and that autonomous runs will now correctly stop for approval more often
- [x] 5.5 Run `pnpm test:e2e` and confirm no regression in end-to-end suites
