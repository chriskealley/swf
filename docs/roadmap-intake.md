# Roadmap-driven workflow entry

SWF can start its next piece of work straight from an [OpenRoad](https://www.npmjs.com/package/@chriskealley/openroad) roadmap instead of requiring you to translate a roadmap outcome into a change name by hand. This is optional: every existing direct entry command keeps working unchanged, and a project without a roadmap never touches OpenRoad.

## Authority boundary

OpenRoad and SWF own different things, and neither reaches into the other:

- **OpenRoad owns the roadmap.** It parses `openspec/roadmap.md`, evaluates priority and dependencies, decides which item is eligible, and performs every roadmap lifecycle transition. SWF never ranks, skips, or manufactures roadmap work, and never edits the roadmap file.
- **SWF owns execution.** Once an item is associated with an OpenSpec change and a run, the SWF service is the sole scheduler and active-state writer, exactly as it is for direct entry. OpenRoad has no say over phases, gates, or delivery.

The integration contract is OpenRoad's versioned machine-readable output, not its internals. SWF supports OpenRoad `0.2.0` and later `schemaVersion: 1` documents from `openroad next --json` and `openroad start <id> --change <name> --json`, and validates them strictly. An unrecognized document shape fails closed with a diagnostic rather than being guessed at.

## Prerequisites

OpenRoad is an optional dependency. Install it only if you want roadmap intake:

```sh
npm install --global @chriskealley/openroad@0.2.0
openroad init
```

`swf doctor` ignores OpenRoad unless you ask for it, so a direct-entry project never sees roadmap diagnostics:

```sh
swf doctor --roadmap
```

That adds two checks: `tool.openroad` (installed and at least `0.2.0`) and `roadmap.openroad` (this project's roadmap validates). A missing OpenRoad is a warning, because intake is optional; an invalid roadmap is a failure, because intake cannot proceed against one.

## Starting work

```sh
swf roadmap new        # select the next eligible item, execute Planning, stop
swf roadmap run        # select the next eligible item, then progress automatically
swf roadmap reconcile  # settle an interrupted intake without selecting new work
```

These take no change argument: naming a change is exactly what they exist to avoid. The CLI does not pick the work — it asks the service, which asks OpenRoad, so the service remains the only writer of active state.

On a successful selection the service, in order:

1. validates OpenRoad and settles any unfinished intake intent;
2. asks `openroad next --json` and uses exactly the item it returns;
3. derives a deterministic kebab-case change name from the item title, adding the roadmap ID when two items would otherwise collide;
4. records the intent durably before any side effect;
5. creates the OpenSpec change scaffold and the single SWF run, stamping the roadmap item, title, and operation ID onto the run;
6. calls the idempotent `openroad start` to link the change and activate the item;
7. enters Planning through the same scheduling path as `swf new` / `swf run`.

OpenRoad links a change that exists at the project root, while a run's planning
artifacts live in its isolated worktree until delivery merges them. Intake
therefore creates the change directory at the project root before linking. It
stays empty — SWF writes no planning content outside the run — and Git ignores
empty directories, so the working tree is not dirtied.

`swf roadmap new` stops after Planning. `swf roadmap run` continues through eligible phases under the existing run policy.

## Machine-readable results

`--json` returns a versioned envelope. Intake classification is reported separately from run execution status so automation can tell normal roadmap exhaustion from a failed run:

| `intake`           | Meaning                                                           | Change or run created |
| ------------------ | ----------------------------------------------------------------- | --------------------- |
| `selected`         | A new item was associated and started                             | yes                   |
| `resumed`          | The request converged on an association that already existed      | no                    |
| `recovered`        | An interrupted association was completed                          | only the missing part |
| `no-eligible-work` | OpenRoad reports nothing is ready                                 | no                    |
| `invalid-roadmap`  | OpenRoad could not validate the roadmap                           | no                    |
| `conflict`         | An item, change, or run is already associated with something else | no                    |

The envelope carries `itemId`, `itemTitle`, `changeName`, `runId`, the run `status` and `phaseId` whenever they are known, OpenRoad's own `diagnostics` verbatim, any `conflicts` with every observed identity, and an executable `nextAction`. It contains no interactive prose. When a run exists the usual operator `projection` is attached, so the CLI, the dashboard, and the Pi extension all read the same service-owned state.

```sh
swf roadmap new --json | jq '{intake, itemId, changeName, runId, status}'
```

Non-success classifications exit non-zero.

## Recovery and idempotency

No transaction can span the roadmap file, the OpenSpec scaffold in a run worktree, and `.swf-state`. Intake is therefore a journaled saga, serialized per project by an intake lock, with a durable record written before any side effect. Each step only ever moves forward, and every step is re-derived from durable state on retry, so an interruption converges instead of duplicating work:

- **A recorded intent with no run** — the missing run is created and bound to the change the intent already names, then Planning starts or resumes.
- **A run with no roadmap activation** — `openroad start` is retried; it is idempotent, so it reports the existing link rather than failing.
- **A lost completion write** — the record is simply advanced; nothing is created twice.

Repeating `swf roadmap new` after a successful intake returns `resumed` with the same item, change, and run. Unrelated active, blocked, or paused roadmap items are not treated as conflicts: whatever OpenRoad returns is what SWF starts.

Incomplete intents are settled automatically when the service starts, and can be settled on demand with `swf roadmap reconcile`, which never selects new work.

### Conflicts

When an item, change, or run turns out to be associated with a different counterpart, SWF performs no reassignment and no new selection. It reports every identity it observed and stops, because guessing which association was intended is exactly the thing that would make OpenRoad and SWF disagree silently. Resolve the conflict in the roadmap or in SWF state, then rerun.

SWF reconciles the intake intents it durably recorded, and only those. An item linked entirely outside SWF — for example by running `openroad start` by hand — leaves no such intent. OpenRoad `0.2.0`'s machine-readable operations report only the next eligible item, never an already-active one, and SWF will not parse the roadmap to find it, because reading the roadmap directly is exactly the authority boundary this design keeps. Start such an item with direct entry using the change name it is already linked to:

```sh
swf new <change-name> --description "..."
```

## Direct entry is unaffected

```sh
swf new improve-login --description "Improve login reliability"
swf run improve-login
```

Direct entry still requires an explicit change name, never requires a roadmap, and never mutates one. A run created this way has no roadmap provenance, and SWF does not fabricate one for it. Roadmap provenance is an optional field on the durable run document, so runs created before this feature existed continue to load unchanged.
