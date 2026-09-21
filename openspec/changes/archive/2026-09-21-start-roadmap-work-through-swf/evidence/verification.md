# Verification evidence

Date: 2026-09-21

## Environment

- OpenRoad `@chriskealley/openroad@0.2.0`, installed globally and on `PATH`.
- Node.js 24.16.0 on darwin/arm64.

The roadmap end-to-end fixtures drive the real `openroad` binary rather than a
restatement of its contract. They are guarded by an availability probe and skip
with the rest of the suite when OpenRoad is absent, so the repository still
verifies without the optional dependency installed. In this run OpenRoad was
present and all nine fixtures executed.

## Commands

| Command                                                   | Result                                            |
| --------------------------------------------------------- | ------------------------------------------------- |
| `pnpm format` then `pnpm format:check`                     | all files match Prettier style                    |
| `pnpm lint`                                                | no ESLint findings                                |
| `pnpm typecheck`                                           | `tsc -b` clean                                    |
| `pnpm test:unit`                                           | 423 tests passed across 37 files                  |
| `pnpm test:integration`                                    | 104 tests passed across 11 files                  |
| `pnpm test:e2e`                                            | 32 passed, 7 skipped across 8 files               |
| `openspec validate start-roadmap-work-through-swf --strict`| change is valid                                   |

## Environment-limited verification

Seven end-to-end tests were skipped, all pre-existing and unrelated to roadmap
intake:

- Six in `e2e/preview.test.ts`, which require a previously built product
  artifact to stage and inspect.
- One live harness smoke test in `e2e/acceptance.test.ts`, which is explicitly
  opt-in and requires an authenticated harness.

No roadmap intake test was skipped.

## Defects found by the real-CLI fixtures

Two defects were found by verification rather than by inspection, and both are
fixed:

1. The intake result read the run's creation-time document instead of its
   reconstructed state, so the execution guard saw a permanently `pending`
   status and could attempt to resume a run that was already blocked.
2. `openspec new change` scaffolds inside the run's isolated worktree, but
   `openroad start` requires the change to exist at the project root it is
   given. Intake now creates that directory — and only that directory — before
   linking. This was invisible to the fake-adapter tests and only appeared once
   the fixtures drove the real OpenRoad CLI.

## Review findings

Three conformance gaps were raised in review and are fixed:

1. `swf migrate` constructed `StateMigrationManager` without the roadmap
   migrations or target version, so the v1→v2 migration could not be
   discovered through the real service path. The service now passes
   `roadmapIntakeMigrations` and `ROADMAP_INTAKE_STATE_VERSION`, covered by
   service-level preview, apply, and rollback tests that also assert existing
   run bindings and an existing journal survive.
2. The `Roadmap link exists without a run` scenario was broader than OpenRoad
   0.2.0 permits, because its operations never report an already-active item
   and SWF will not parse the roadmap. The scenario is now qualified to an item
   with a durably recorded intake intent, and a companion scenario states that
   a link made outside SWF is not adopted, with an end-to-end fixture proving
   it creates nothing and leaves the roadmap untouched.
3. `openroad start` responses were accepted without checking them against the
   request. The adapter now rejects a drifted root, item ID, or change name as
   a conflict, and the service repeats the identity check at the durable write
   so no adapter can complete a record for work it was not asked to link.

## Roadmap mutation boundary

`e2e/roadmap-intake.test.ts` reads `openspec/roadmap.md` before and after every
scenario. Outcomes that create nothing — no eligible work, invalid roadmap,
conflict, and reconcile-only — leave the file byte-identical, and the only
observed mutations are the activations OpenRoad itself performed through
`openroad start`.
