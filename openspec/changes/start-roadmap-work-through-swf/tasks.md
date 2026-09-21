# Tasks

## 1. OpenRoad Integration Contract

- [x] 1.1 Add typed Zod schemas and result classifications for OpenRoad 0.2.0 doctor, next, and start JSON output, and verify unit tests reject unsupported or malformed responses.
- [x] 1.2 Implement an injectable OpenRoad process adapter that preserves diagnostics and never performs local eligibility logic, and verify adapter tests cover success, no eligible work, invalid roadmap, command failure, and idempotent start.
- [x] 1.3 Extend SWF installation/project diagnostics to report OpenRoad readiness only when roadmap intake is requested or configured, and verify direct-entry diagnostics remain valid without OpenRoad.

## 2. Durable Intake State

- [x] 2.1 Add optional roadmap provenance to versioned run and run-created event schemas, fixtures, and TypeScript types, and verify legacy direct-entry run documents still parse unchanged.
- [x] 2.2 Add a versioned, atomically written intake journal and per-project intake lock for operation, item, change, run, and monotonic step state, and verify concurrent writers serialize without losing state.
- [x] 2.3 Add the state migration and schema exports needed for roadmap provenance and intake journals, and verify migration preview/apply/rollback tests preserve existing run bindings.

## 3. Selection and Reconciliation

- [x] 3.1 Implement deterministic change-name derivation from the selected roadmap item with stable collision handling, and verify unit tests cover punctuation, duplicate titles, and existing identities.
- [x] 3.2 Implement the service-owned intake saga that validates, reconciles, selects, journals, prepares the existing OpenSpec/SWF run, invokes idempotent OpenRoad start, and enters Planning, and verify service tests cover both single-phase and automatic modes.
- [x] 3.3 Reconcile a linked item with no run and a matching run with no roadmap activation before new selection, and verify fault-injection tests at every durable write point converge on one item, change, and run after retry.
- [x] 3.4 Detect mismatched item/change/run associations without reassignment, and verify conflict tests leave roadmap, change, and run state unmodified while returning all observed identities.
- [x] 3.5 Run incomplete-intake reconciliation during service recovery and explicit reconcile operations, and verify restart tests resume safe work while ambiguous identity remains blocked.

## 4. Operator Surfaces

- [x] 4.1 Add explicit CLI commands or flags for roadmap Planning-only entry and automatic roadmap entry that delegate selection to the service, and verify command tests preserve the required change argument and behavior of existing `swf new` and `swf run` entry paths.
- [x] 4.2 Add versioned service command/result contracts for selected, resumed, recovered, no-eligible-work, invalid-roadmap, and conflict outcomes, and verify JSON contract tests include item, change, and run identities whenever known.
- [x] 4.3 Extend human output, operator projections, Pi integration, and executable next-action guidance for roadmap intake results, and verify cross-client tests observe the same service-owned state.

## 5. Documentation and End-to-End Verification

- [x] 5.1 Document OpenRoad 0.2.0 as an optional intake dependency, the explicit roadmap entry workflow, authority boundary, diagnostics, and recovery guidance, and verify documentation examples match CLI help.
- [x] 5.2 Add end-to-end fixtures for priority/dependency selection, concurrent active work, no eligible work, invalid roadmaps, repeated intake, and both partial-start recovery directions, and verify the roadmap is mutated only through OpenRoad operations.
- [x] 5.3 Run formatting, lint, type checking, unit, integration, and end-to-end suites plus `openspec validate start-roadmap-work-through-swf --strict`, and record any environment-limited verification in the change evidence.
