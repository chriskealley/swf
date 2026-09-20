# Proposal

## Why

Roadmap item RM-004 calls for projects with a valid OpenRoad roadmap to start the highest-priority eligible outcome through SWF without manually translating that outcome into a change and run. The intake must be recoverable and idempotent so OpenRoad and SWF cannot silently disagree after an interruption.

## What Changes

- Add an optional roadmap-driven SWF entry path that asks OpenRoad 0.2.0 for the next eligible item, derives a change identity, creates and links the OpenSpec change, creates the SWF run, and starts Planning.
- Preserve the existing direct `swf new` and `swf run` paths for projects or operators that do not use roadmap intake.
- Persist roadmap item identity and linkage provenance with the run so repeated intake, status, diagnostics, and recovery can identify the same work.
- Reconcile partial startup in either direction: complete or resume an item whose OpenRoad link exists without a run, and link an existing matching run whose roadmap item was not yet activated.
- Surface no-eligible-work, invalid-roadmap, conflicting-link, and unrecoverable reconciliation outcomes without selecting work independently of OpenRoad or creating duplicate changes/runs.
- Extend service, CLI, and operator-facing status with stable machine-readable roadmap intake results while keeping the service as the execution authority after intake.

## Capabilities

### New Capabilities

- `roadmap-intake`: Optional OpenRoad selection, OpenSpec change linkage, SWF run startup, idempotency, and cross-system recovery.

### Modified Capabilities

- `change-run-lifecycle`: Record roadmap provenance on a run and reconcile roadmap/change/run bindings as part of durable startup and recovery.
- `operator-interfaces`: Expose roadmap-driven entry and its selection, no-work, conflict, and recovery outcomes through the shared service API and CLI.

## Impact

- Affects the service command path and scheduler startup, durable run schemas/events and migrations, CLI entry commands and JSON output, operator projections, diagnostics, and recovery.
- Adds a versioned OpenRoad 0.2.0 integration boundary; OpenRoad remains authoritative for eligibility and roadmap lifecycle, while SWF remains authoritative for run execution.
- Requires unit, service, CLI, and end-to-end coverage for selection order, optional operation, idempotent retries, concurrent active items, and both partial-failure recovery directions.
- Roadmap link: RM-004 (`start-roadmap-work-through-swf`).
