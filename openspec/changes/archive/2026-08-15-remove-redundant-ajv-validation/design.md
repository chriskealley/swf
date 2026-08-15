## Context

`packages/core/src/schemas.ts` defines ~30 versioned document schemas in Zod under a `documents` map, exposing three things built on it:

- `parseDocument(name, value)` — Zod parse, the path all production code uses.
- `jsonSchemas` — a map generated at module load via `z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" })`.
- `validateJsonDocument(name, value)` — constructs `new Ajv2020({ allErrors: true, strict: false })` and validates against `jsonSchemas[name]`.

The dependency direction matters: the JSON Schema is *generated from* Zod, so Ajv validates a strictly lossier artifact. `unrepresentable: "any"` widens anything JSON Schema cannot express — refinements, transforms, branded types — to `any`. A document that Ajv accepts may still fail Zod; a document Ajv rejects would also fail Zod. The Ajv path therefore adds no rejection power.

A repo-wide search shows `validateJsonDocument` and `jsonSchemas` have **no production callers**. The only references are three assertions in `packages/core/test/schemas.test.ts`. Meanwhile `ajv` sits in `dependencies` of `@swf/core` and ships to users, which is directly relevant to the in-flight `productize-development-and-distribution` work.

## Goals / Non-Goals

**Goals:**
- Establish one runtime validation authority (Zod) and record it in the spec so the duplication cannot silently reappear.
- Remove `ajv` from the `@swf/core` runtime dependency set.
- Preserve — and make deliberate — the one guarantee the Ajv path implicitly provided: that the generated JSON Schemas are well-formed and compilable by a real validator.
- Keep existing test coverage (valid fixture, invalid fixture, future-version fixture) at equal or better strength.

**Non-Goals:**
- Removing or changing the `jsonSchemas` export. It is a legitimate interoperability surface for consumers who cannot run Zod.
- Changing any Zod document schema, its shape, or its version semantics.
- Auditing or reworking validation call sites elsewhere in the codebase.
- Replacing Ajv with a different JSON Schema validator in production code.

## Decisions

### 1. Remove `validateJsonDocument` rather than deprecate it

It is exported from `@swf/core` but referenced only by tests, so a deprecation period buys nothing — there are no callers to migrate. Deleting outright keeps the module's public surface honest.

*Alternative considered:* mark `@deprecated` and remove in a later change. Rejected: it would keep `ajv` in `dependencies` for the duration, which is the actual cost we are removing. A deprecation that does not shrink the dependency set defers the entire benefit.

### 2. Keep `jsonSchemas`, drop only the validation path

The generated schemas and the runtime validator are separable concerns. The schemas are useful to external tooling; the second validator is not. Removing only the validator gets the benefit without narrowing the published interface.

*Alternative considered:* remove both and generate schemas in a build step. Rejected as a larger change with its own packaging questions — out of proportion to the problem, and it would remove a surface external consumers may already depend on.

### 3. Move Ajv to `devDependencies` and assert schema compilability in a test

Deleting `validateJsonDocument` outright would silently drop a real (if incidental) guarantee: that `z.toJSONSchema` emits something a standards-compliant validator can actually compile. A `z.toJSONSchema` regression or a Zod upgrade could otherwise emit a malformed schema and nobody would notice until an external consumer complained.

The fix is to state that guarantee as a test rather than infer it from runtime code: iterate every entry in `jsonSchemas` and assert `new Ajv2020(...).compile(schema)` succeeds. Ajv remains available for this, as a `devDependency` that does not ship.

*Alternative considered:* drop Ajv entirely and assert only that the generated object is non-empty. Rejected: a shape assertion does not prove compilability, which is the property external consumers actually depend on. A dev-only dependency is cheap.

### 4. Rewrite the existing tests against `parseDocument` / `safeParse`

The three current assertions cover a valid fixture, an invalid fixture, and a future-schema-version fixture (`run.valid.json`, `run.invalid.json`, `run.future.json`). Each has a direct Zod equivalent. Rewriting rather than deleting keeps fixture coverage intact and — because Zod is strictly stricter — the invalid and future cases should still fail, now for more precise reasons.

## Risks / Trade-offs

- **An undiscovered caller depends on `validateJsonDocument`'s `{ valid, errors }` shape** → A repo-wide search over `packages`, `apps`, `extensions`, and `swf.ts` found callers only in tests. `typecheck` and `lint` across the workspace will catch anything missed, since the export is typed and every consumer is in-repo.
- **Losing incidental JSON Schema regression detection** → Directly mitigated by Decision 3; the compilability test asserts more precisely what the runtime path checked incidentally.
- **An external consumer imports `validateJsonDocument` from `@swf/core`** → `@swf/core` is `private: true` and unpublished; there is no external consumer today. This is exactly the right moment to trim the surface, before distribution makes it a compatibility obligation.
- **Ajv drifts out of date as a dev-only dependency** → Acceptable. Its only job becomes compiling generated schemas in tests; a lagging version still validates draft-2020-12 correctly, and a failure surfaces in CI rather than at runtime.

## Migration Plan

1. Move `ajv` from `dependencies` to `devDependencies` in `packages/core/package.json`.
2. Delete `validateJsonDocument` and the `Ajv2020` import from `packages/core/src/schemas.ts`.
3. Rewrite the three affected assertions in `packages/core/test/schemas.test.ts` to use `parseDocument` / `safeParse`; add the schema-compilability test over `jsonSchemas`.
4. Run `pnpm check` and `pnpm test` to confirm no remaining references and no coverage regression.

**Rollback:** the change is a single self-contained commit touching three files with no data-format or persisted-state implications. Reverting the commit fully restores prior behavior.

## Open Questions

None. The removal target has no production callers and the replacement guarantee is well defined.
