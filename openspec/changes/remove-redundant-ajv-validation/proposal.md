## Why

`packages/core/src/schemas.ts` carries two validation authorities for the same documents. `jsonSchemas` is *generated from* the Zod document schemas via `z.toJSONSchema(...)`, and `validateJsonDocument` then validates values against that generated schema using Ajv. Because the JSON Schema is derived from Zod — with `unrepresentable: "any"`, which silently drops refinements — the Ajv path can never be stricter than `documents[name].safeParse()`, only lossier. It is a weaker duplicate of a check the project already has.

The cost is real: `validateJsonDocument` constructs a new `Ajv2020` instance and recompiles the schema on **every call**, and `ajv` is a runtime dependency of `@swf/core` that ships in the distributed package. No production code calls it — the only callers are in `packages/core/test/schemas.test.ts`. Removing it while the distribution work is in flight avoids shipping a dependency that earns nothing.

## What Changes

- Remove `validateJsonDocument` from `packages/core/src/schemas.ts` and drop the `ajv` dependency from `@swf/core`.
- Retain the exported `jsonSchemas` map. It is the project's published JSON Schema surface for external consumers and is independently useful; only the redundant *runtime validation* path is removed.
- Add a test that verifies each generated JSON Schema is well-formed and usable by a standards-compliant validator, so the guarantee `validateJsonDocument` implicitly provided is asserted deliberately rather than as a side effect of runtime code. Ajv moves to a `devDependency` for this purpose only.
- Replace the `validateJsonDocument` assertions in `packages/core/test/schemas.test.ts` with equivalent assertions over `parseDocument` / `safeParse`, preserving the existing valid / invalid / future-fixture coverage.
- **Not breaking** for any shipped behavior: `validateJsonDocument` has no production callers. It is exported from `@swf/core`, so this is a breaking change to that package's public type surface, but every workspace consumer is internal and none reference it.

## Capabilities

### New Capabilities

None. This change removes a redundant implementation path and introduces no new runtime behavior.

### Modified Capabilities

- `factory-project-configuration`: adds a requirement establishing a **single authoritative document validator**. No spec currently states which validator is authoritative, which is what allowed a second, weaker validation path to accumulate. The change records that Zod document schemas are the sole runtime authority and that the published JSON Schemas are a derived, non-authoritative export — so the duplication cannot silently return.

## Impact

- **Code**: `packages/core/src/schemas.ts` (remove `validateJsonDocument`, remove the `Ajv2020` import); `packages/core/test/schemas.test.ts` (rewrite three assertions, add a schema-shape test).
- **Dependencies**: `ajv` moves from `dependencies` to `devDependencies` in `packages/core/package.json`, reducing the runtime dependency footprint of the distributed package.
- **Performance**: removes per-call Ajv instantiation and schema compilation from any future caller that would have reached for it.
- **Risk**: low. The removed function is unreferenced outside tests; the change is additive-safe for the `jsonSchemas` export that external consumers may rely on.
- **Related**: complements the packaging work in `productize-development-and-distribution`, which is sensitive to what `@swf/core` pulls in at runtime.
