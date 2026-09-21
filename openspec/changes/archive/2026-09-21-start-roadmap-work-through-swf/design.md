# Design

## Context

See `proposal.md` for motivation. Today the CLI requires a change name, the service creates durable run state before launching Planning, and `RunEventStore` enforces the one-change-to-one-run binding. OpenRoad already owns roadmap validation, eligibility ordering, and idempotent activation through versioned JSON operations. The integration crosses CLI, service commands, durable schemas/events, recovery, and operator projections.

## Goals / Non-Goals

**Goals:**

- Reuse the existing service-owned workflow entry after resolving a roadmap item into a stable change and run association.
- Make every interruption point convergent under retry without duplicating an OpenSpec change, SWF run, or roadmap link.
- Keep direct entry backward compatible and keep OpenRoad optional.
- Preserve useful, versioned JSON outcomes from both OpenRoad intake and SWF execution.

**Non-Goals:**

- Reimplementing roadmap parsing, dependency evaluation, priority ordering, or lifecycle transitions inside SWF.
- Making OpenRoad a scheduler or allowing it to control phases after intake.
- Automatically completing or archiving roadmap items as part of this change; existing archive coordination remains authoritative.
- Supporting arbitrary pre-0.2.0 OpenRoad output formats.

## Decisions

### Add explicit roadmap variants of the existing entry intent

Expose roadmap intake as explicit CLI/service entry modes for “Planning then stop” and automatic progression. The CLI does not preselect work; it asks the service, preserving the service as sole active-state writer. After association, both modes call the same internal execution path as `new` and `run`.

Alternative: infer roadmap use when `swf new` omits a change name. Rejected because optional behavior would become context-dependent and would weaken automation and error clarity.

### Wrap OpenRoad 0.2.0 JSON operations behind a typed adapter

Introduce a core adapter that invokes `openroad doctor`, `openroad next --json`, and `openroad start <item> --change <name> --json`; validates their versioned output with Zod; and maps process failures into stable intake result categories. Keep CLI syntax and process execution out of orchestration code so tests can use a fake adapter.

Alternative: import undocumented OpenRoad internals. Rejected because the roadmap promises versioned machine-readable operations as the integration contract.

### Derive and persist identity before side effects

Derive a deterministic kebab-case change name from the selected roadmap item, with the roadmap ID included when needed to prevent collisions. Persist an intake record under project state containing an operation ID, item ID, proposed change name, observed OpenRoad state, run ID when allocated, and step state. Add optional roadmap provenance to the versioned run document and creation event. Writes remain atomic and schema-migrated.

Alternative: infer provenance later from the roadmap Markdown or change description. Rejected because partial recovery requires durable intent independent of mutable presentation text.

### Use a reconciled saga for cross-system startup

No transaction spans OpenRoad files, the OpenSpec scaffold in a run worktree, and `.swf-state`. Model startup as a monotonic saga guarded by the service's per-project intake lock:

1. validate OpenRoad and reconcile unfinished intake records;
2. select exactly the item returned by `openroad next --json`;
3. persist the intake intent and derived change name;
4. create the durable SWF run and OpenSpec scaffold through the existing preparation path, recording its run ID in the intent;
5. call idempotent `openroad start` for that item/change;
6. mark the association complete and enter Planning.

On retry, observed matching state advances the record. A linked item without a run uses its recorded change to create the missing run. A matching run without activation retries `openroad start`. Any mismatched identity becomes a conflict and stops before new selection.

Alternative: activate the roadmap item first and then invoke ordinary entry with no journal. Rejected because interruption would leave insufficient durable evidence to distinguish safe completion from conflicting reuse.

### Report intake separately from execution status

Return a versioned envelope containing intake classification (`selected`, `resumed`, `recovered`, `no-eligible-work`, `invalid-roadmap`, or `conflict`), known identities, and the normal run projection when a run exists. Human output summarizes selection and an executable next action; JSON output remains free of interactive text.

Alternative: flatten OpenRoad failures into generic service errors. Rejected because automation and recovery need to distinguish normal exhaustion from invalid or conflicting state.

## Risks / Trade-offs

- [A process boundary cannot provide a true transaction] → Use atomic intent writes, idempotent OpenRoad activation, a per-project lock, and reconciliation before further selection.
- [Derived change names can collide] → Include the stable roadmap ID in the deterministic fallback and reject any existing change/run with different provenance.
- [OpenRoad output evolves] → Pin the supported integration floor to 0.2.0, validate versioned JSON, and fail closed with diagnostics for unsupported shapes.
- [Run schema changes affect existing state] → Make provenance optional, add a forward migration, and retain fixtures proving legacy direct-entry runs still load.
- [Two service requests race for the same eligible item] → Serialize roadmap intake per project and re-run selection/reconciliation inside the lock.

## Migration Plan

1. Add optional provenance and intake-state schemas plus migration coverage; existing runs remain valid without roadmap fields.
2. Add the OpenRoad adapter and reconciliation service behind new explicit command types.
3. Add CLI/operator projections and documentation without changing direct-entry syntax.
4. Release with OpenRoad intake disabled unless explicitly invoked; rollback removes the new entry surface while leaving optional provenance readable and unfinished records diagnosable.
