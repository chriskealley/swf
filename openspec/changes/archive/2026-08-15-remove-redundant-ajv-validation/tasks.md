## 1. Confirm the removal is safe

- [x] 1.1 Search `packages`, `apps`, `extensions`, and `swf.ts` for `validateJsonDocument` references and confirm all are inside `packages/core/test/schemas.test.ts`
- [x] 1.2 Search for `jsonSchemas` consumers and confirm the export is retained for external use only, with no runtime validation callers

## 2. Preserve the schema-compilability guarantee

- [x] 2.1 Add a test in `packages/core/test/schemas.test.ts` that iterates every entry in `jsonSchemas` and asserts `new Ajv2020({ strict: false }).compile(schema)` succeeds
- [x] 2.2 Verify the new test fails if a deliberately malformed schema is injected, so it is proven to be load-bearing before the runtime path is removed

## 3. Rewrite existing validation assertions

- [x] 3.1 Replace the `run.valid.json` assertion with an equivalent `parseDocument("run", value)` success assertion
- [x] 3.2 Replace the `run.invalid.json` assertion with a `RunSchema.safeParse` failure assertion, asserting on the offending field path
- [x] 3.3 Replace the `run.future.json` assertion with a Zod equivalent, preserving the existing schema-version rejection coverage

## 4. Remove the redundant validation path

- [x] 4.1 Delete `validateJsonDocument` from `packages/core/src/schemas.ts`
- [x] 4.2 Remove the `Ajv2020` import from `packages/core/src/schemas.ts`
- [x] 4.3 Move `ajv` from `dependencies` to `devDependencies` in `packages/core/package.json` and refresh the lockfile
- [x] 4.4 Document `jsonSchemas` as a derived, non-authoritative export per the spec's derived-export scenario

## 5. Verify

- [x] 5.1 Run `pnpm typecheck` and confirm no unresolved references to the removed export
- [x] 5.2 Run `pnpm test:unit` and `pnpm test:integration` and confirm all suites pass
- [x] 5.3 Run `pnpm check` (format, lint, typecheck) and confirm it is clean
- [x] 5.4 Confirm `ajv` no longer appears in the resolved runtime dependency set for `@swf/core`
- [x] 5.5 Migrate the `e2e/foundation.test.ts` caller missed by the task 1.1 search scope, and re-search every tracked file
- [x] 5.6 Update the `docs/architecture.md` tooling list, which named Ajv as the validator at persisted boundaries
- [x] 5.7 Run `pnpm test:e2e` and confirm no regression
