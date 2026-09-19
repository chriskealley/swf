# SWF Roadmap

This roadmap coordinates product outcomes with OpenSpec changes. `Status` is
the lifecycle state; `Work state` is present only while an item is active.
Multiple items may be active at once, and lower priority numbers are considered
first when more than one ready item is eligible.

## Status model

- `planned` — captured but not ready to start
- `ready` — sufficiently defined and eligible once dependencies are done
- `active` — linked to an OpenSpec change and currently being delivered
- `done` — shipped and its OpenSpec change archived
- `cancelled` — intentionally abandoned

Active work states are `available`, `blocked`, or `paused`.

## Items

### RM-001 — Establish the agentic software factory foundation

**Status:** done
**Priority:** 10
**Depends on:**

Deliver the persistent service, OpenSpec run lifecycle, isolated phase
execution, checks and gates, evidence, operator surfaces, harness adapters, and
Git delivery that define SWF. Acceptance is the archived
`build-agentic-software-factory` change with its implementation verification
evidence.

### RM-002 — Make operation clear and execution defaults dependable

**Status:** done
**Priority:** 20
**Depends on:** RM-001

Give operators human-oriented progress and recovery guidance, explicit model
tier routing, phase-specific contracts, deterministic verification and release
behavior, and readable normalized harness output. Acceptance is the archived
operator-experience, execution-defaults, and harness-presentation work with
live Pi/Herdr evidence.

### RM-003 — Ship a reproducible public preview

**Status:** done
**Priority:** 30
**Depends on:** RM-002

Turn the source workspace into installable, verifiable product and Pi-extension
packages with isolated development, managed service operation, safe upgrades,
release evidence, checksums, and an SBOM. Acceptance is the archived
`productize-development-and-distribution` change and published `v0.1.0`
artifacts.

### RM-008 — Adopt tokenless npm trusted publishing

**Status:** ready
**Priority:** 50
**Depends on:** RM-003

Replace long-lived npm publication tokens with workflow-bound OIDC trusted
publishing for both the SWF product and Pi extension while preserving the
protected release environment, explicit stable-release approval, exact-artifact
promotion, publish-before-tag ordering, provenance, and fail-closed release
guards. Acceptance requires the workflow, documentation, policy tests, and
release specification to describe and enforce tokenless publication, with the
matching trusted-publisher configuration recorded as an external release
prerequisite.

### RM-004 — Start eligible roadmap work through SWF

**Status:** ready
**Priority:** 100
**Depends on:** RM-003

Use OpenRoad as an optional intake layer before the existing SWF lifecycle. If
a project has a valid roadmap, SWF selects the highest-priority eligible item,
creates and links its OpenSpec change, starts Planning, and then relies on the
existing checks, approvals, phase gates, evidence, recovery, and delivery
behavior. OpenRoad remains the authority for roadmap selection and lifecycle;
SWF remains the authority for execution after intake.

OpenRoad 0.2.0 provides versioned, machine-readable operations for selecting
the next eligible item and idempotently recording its active change. SWF must
build on those operations and provide recovery so an interruption cannot leave
a roadmap item without its SWF run or a run without its roadmap link.

### RM-005 — Evaluate typed decision models for semantic gates

**Status:** planned
**Priority:** 200
**Depends on:** RM-003

Investigate TypeSafe Jev and the broader typed-decision pattern for bounded
semantic judgments that are currently agent-derived, such as whether evidence
substantively satisfies a task or whether a finding should block progression.
Keep deterministic checks, explicit policy, and human authority primary; a
typed answer is not treated as proof of correctness.

Acceptance is a shadow-mode evaluation over representative historical and live
SWF decisions, covering accuracy, calibration, confidence thresholds,
escalation, privacy, provider availability, model provenance, and fail-closed
behavior. The outcome is an evidence-backed decision to adopt, reject, or
continue evaluating the approach rather than a commitment to a specific hosted
model.

### RM-006 — Validate SWF through sustained real-project operation

**Status:** planned
**Priority:** 300
**Depends on:** RM-004, RM-005

Exercise roadmap-driven intake and the resulting SWF workflows across
representative real repositories on supported macOS and Linux environments.
Cover installation, project onboarding, planning approval, multi-phase
execution, recovery, pull-request delivery, upgrade, and uninstall while
capturing decision quality, operational friction, and failure evidence.

The outcome is complete when a new operator can take eligible roadmap work to
a delivered change from the published package without source-checkout
knowledge or undocumented intervention, and the resulting acceptance matrix is
repeatable.

### RM-007 — Stabilize the product contract

**Status:** planned
**Priority:** 400
**Depends on:** RM-006

Use sustained operational evidence to decide which CLI, API, configuration,
extension, decision-evidence, and stored-state contracts are ready to become
durable. Document migration windows and deprecation rules, complete security
and operational readiness review, and choose an appropriate stable release
target only when supported upgrades preserve committed configuration and run
history.

## Deferred considerations

- Additional package and deployment channels should be prioritized only when
  adopter demand justifies them.
- Native Windows support should be reconsidered after Herdr provides the
  required production-grade Windows process and terminal support.
