## Context

Generated SWF projects currently receive five nearly identical profiles, one-line guidelines, empty phase checks, and one general-purpose agent work unit per phase. Profiles advertise model selection but do not select a model, so every phase inherits the harness default. The service adds a detailed hard-coded Planning instruction but gives later phases only a generic request to complete the phase objective.

The live local workflow demonstrated three related problems. First, the same high-capability Pi default model was used even where deterministic or lower-cost work was appropriate. Second, vague contracts allowed agents to invent phase semantics, including archiving during Releasing. Third, automatic gates had little meaningful default evidence because generated workflows declared no project checks.

The architecture must retain project ownership of `.swf/`, the service as sole scheduler and writer, fail-closed evidence and budgets, explicit trust, and no silent installation, command execution, configuration replacement, merge, or authorization creation.

## Goals / Non-Goals

**Goals:**
- Route each agent phase through a provider-neutral model tier with deterministic static resolution.
- Make phase responsibilities, outputs, prohibitions, and completion criteria explicit and inspectable.
- Keep Reviewing responsible for code review and make Verifying responsible for auditing OpenSpec task completion and deterministic evidence.
- Make Releasing a deterministic approval-aware merge/delivery and cleanup phase rather than a general-purpose agent.
- Give new projects safer and more useful defaults without silently changing existing projects.
- Discover candidate project checks read-only and require explicit adoption before execution.

**Non-Goals:**
- Dynamic model routing based on inferred difficulty, cost, or model output.
- Automatic model escalation after failure.
- A universal concrete model list embedded permanently in SWF.
- Treating a checked OpenSpec task as proof of correct implementation.
- Turning Verifying into another general code-review agent.
- Allowing Planning approval to imply final merge authorization.
- Silently updating committed project configuration.

## Decisions

### 1. Introduce static model tiers with explicit harness mappings

Profiles select semantic tiers, while user or project configuration maps each tier to a concrete model for each harness.

```yaml
# User or project model configuration
modelTiers:
  reasoning:
    pi:
      model: provider/reasoning-model
  coding:
    pi:
      model: provider/coding-model
  fast:
    pi:
      model: provider/fast-model
```

Generated profiles use:

```yaml
# planner.yaml
modelTier: reasoning

# builder.yaml
modelTier: coding

# reviewer.yaml
modelTier: reasoning

# verifier.yaml
modelTier: fast
```

Releasing has no model tier because its default work is deterministic.

Resolution follows normal configuration precedence. At the winning layer, an explicit concrete `model` overrides `modelTier`; otherwise the tier resolves through the selected harness mapping. Use of a harness default or alternate model is allowed only when explicitly configured.

```text
resolved phase/profile
        │
        ├── concrete model override ───────▶ validate and use
        │
        └── model tier
                │
                ▼
        harness-specific mapping
                │
        ┌───────┴────────┐
        ▼                ▼
     resolved         missing
        │                │
        ▼                ▼
 capability/budget    fail preflight
 preflight
```

This design makes phase policy portable without pretending concrete model availability is universal. A user can map tiers once across projects; a project can pin mappings where reproducibility requires it.

Dynamic routing was rejected because it would make cost, quality, and reproducibility difficult to audit. A verification failure follows declared retry or remediation policy and never silently escalates the model.

### 2. Replace prompt concatenation with structured phase contracts

A phase contract is structured configuration, not one unversioned prose string. It includes:

- objective
- responsibilities
- allowed paths or mutation scope
- prohibited actions
- required inputs and evidence
- required outputs
- deterministic completion criteria
- handoff requirements

The prompt builder renders the resolved contract together with project guidelines, OpenSpec context, current valid evidence, runtime boundaries, tools, and model resolution. The rendered prompt may be retained as a redacted invocation input fingerprint or bounded artifact, while configuration provenance remains inspectable.

```text
Phase contract ───────────────┐
Project guidelines ───────────┤
OpenSpec status/tasks ────────┤
Valid prior evidence ─────────┼──▶ bounded resolved prompt
Runtime/tool restrictions ────┤
Completion criteria ──────────┤
Model route and budget ───────┘
```

Built-in contracts establish safe semantics. User and project layers can extend or replace supported fields under normal precedence. Prohibitions such as “do not archive or merge” are enforced where possible through tools, phase eligibility, and deterministic service behavior rather than relying only on prose.

### 3. Give each phase a distinct contract

The default responsibilities become:

| Phase | Tier | Primary responsibility | Mutation |
|---|---|---|---|
| Planning | reasoning | Produce valid OpenSpec plan and handoff | Planning artifacts only |
| Building | coding | Implement approved tasks and tests | Application and task state |
| Reviewing | reasoning | Independent structured code review | Read-only by default |
| Verifying | fast | Audit task completion and run required evidence checks | Evidence; remediation only if separately authorized |
| Releasing | none | Approved merge/delivery, dossier, and cleanup | Deterministic service operations |

Reviewing owns broad implementation review. Verifying consumes review results but asks a narrower question: “Has every approved task been completed correctly and proven by current evidence?” This avoids paying for two unconstrained reviews and gives the final gate a testable purpose.

### 4. Make task verification an explicit artifact

Verifying parses `tasks.md`, assigns stable task references from section/task numbering and normalized text, and builds a task audit. Each checked task must map to current implementation and one or more relevant evidence sources. Evidence can include Git paths/diff, deterministic check artifacts, Building evidence, resolved review findings, and specification validation.

```text
Task 3.2
├── checked?                  yes
├── implementation refs      src/..., commit ...
├── required checks          unit-tests, typecheck
├── evidence current?        yes
├── review blockers?         none
└── conclusion               verified
```

Unchecked tasks, stale evidence, unresolved required findings, failed checks, or unsupported claims fail closed. The fast verifier model can summarize and cross-check this bounded material, but it cannot override deterministic failures. Projects requiring stronger reasoning can statically select another tier.

### 5. Replace the Releasing agent with a deterministic state machine

The default Releasing phase does not launch an agent.

```text
Verifying complete
       │
       ▼
Refresh source + target + evidence
       │
       ▼
Persist final pre-delivery dossier
       │
       ▼
┌──────────────────────────────┐
│ Release authorization valid? │
└──────────────┬───────────────┘
          no   │   yes
       ┌───────┴────────┐
       ▼                ▼
 release gate       execute configured
 blocked            merge/delivery
                         │
                  ┌──────┴──────┐
                  ▼             ▼
               failure        success
                  │             │
            preserve state   record result
                                │
                         final dossier commit
                                │
                         owned cleanup
```

Manual policy requires a release-specific approval after Verifying. Planning approval does not authorize merge. Automatic merge requires existing delegated authorization whose scope covers delivery. Direct merge remains subject to `allowDirectMerge`; pull-request behavior remains subject to hosting and repository policy.

Cleanup occurs only after delivery and final evidence are durable. Failure preserves branch, worktree, and owned diagnostic resources. OpenSpec archive is a separate explicit deterministic workflow action; Releasing never infers archive from its name.

### 6. Discover checks, but never adopt or run them silently

Check discovery reads recognized manifests and conventional configuration files and proposes commands with source, phase, cwd, timeout, and required/optional status. For example, package-manager scripts named `build`, `lint`, `typecheck`, or `test` can be candidates. Discovery does not execute scripts.

The operator reviews an exact adoption plan before selected commands are written into `.swf/`. The first execution occurs only as normal declared workflow work. Unknown projects receive no invented commands.

This preserves the rule that SWF never silently executes project code or overwrites configuration.

### 7. Version templates and support selective adoption

Generated configuration includes template metadata and hashes for generated files. A defaults inspection compares:

```text
base template adopted by project
            │
      ┌─────┴─────┐
      ▼           ▼
current project   current installed template
      └─────┬─────┘
            ▼
 unchanged / project-only / upstream-only / conflict
```

Inspection and diff are read-only. Adoption is previewed, selected, confirmed, and backed up. Clean upstream-only updates can be adopted selectively. Overlapping project and template edits produce a reconciliation artifact rather than replacement.

Existing projects continue to execute their committed configuration unchanged until an operator adopts updates. Introducing model tiers therefore does not silently assign models to existing profiles.

### 8. Record resolution and execution provenance

Phase explanation, invocation records, artifacts, budgets, and dossiers record:

- selected model tier
- concrete model and harness
- mapping and override provenance
- fallback, if explicitly used
- phase contract version/fingerprint
- selected evidence fingerprints
- task-audit result
- release authorization and merge result
- cleanup result

This makes cost and quality choices auditable without retaining raw prompts or transcripts in the portable dossier.

## Risks / Trade-offs

- **Tier mappings add setup before first execution** → Provide diagnostics and an explicit guided mapping flow; never hide the missing decision behind harness defaults.
- **Tier names imply comparable capability across providers** → Treat tiers as project policy labels, not objective benchmarks, and always expose the concrete mapping.
- **A fast verifier may miss weak task evidence** → Deterministic checks fail closed, task audits are bounded and structured, and projects can statically select a stronger tier.
- **Structured contracts can become verbose** → Render bounded prompts, select only relevant evidence, and keep contract fields composable.
- **Tool restrictions vary by harness** → Validate advertised capabilities and retain service-side enforcement for archive, merge, authorization, and orchestration boundaries.
- **Automated local merge can mutate the operator's target branch** → Require a release-specific approval or delegated authorization, refresh target state, and block on dirty state or conflict.
- **Cleanup may destroy useful diagnostics** → Run only after successful durable delivery; preserve terminal history and audit markers; retain on any failure.
- **Task-to-implementation mapping is imperfect** → Require explicit evidence references, surface uncertainty as unverified, and avoid claiming semantic proof from checkbox state alone.
- **Template three-way comparison adds metadata complexity** → Keep metadata declarative and disposable; project files remain authoritative.
- **Discovered package scripts can be hostile** → Discovery is read-only, exact command text is shown, and execution requires explicit adoption.

## Migration Plan

1. Add additive model-tier, phase-contract, template-metadata, task-audit, and release-action schemas.
2. Implement static model resolution and phase explanation without changing existing generated projects.
3. Add structured contracts and safer templates for newly initialized projects.
4. Implement task-audit evidence and distinguish Reviewing from Verifying.
5. Implement deterministic Releasing with release-specific approval, delivery, merge, and owned cleanup.
6. Add read-only check discovery and reviewed adoption.
7. Add defaults inspect/diff/selective-adopt with backups and conflict handling.
8. Offer existing projects a preview; never alter them during service startup, registration, diagnostics, or execution.

Rollback leaves existing project-owned configuration intact. Newly adopted configuration can be restored from its backup or reverted through Git. Durable event and artifact schema additions remain readable even if newer execution behavior is disabled.

## Open Questions

- What initial CLI flow should help a user map `reasoning`, `coding`, and `fast` to concrete models without SWF making provider-specific recommendations?
- Should successful pull-request creation end Releasing in `awaiting-merge` with cleanup deferred, or should Releasing remain active until the externally merged PR is observed?
- For local merge, should source-branch deletion default to false even after successful cleanup?
- Which task-reference normalization remains stable when agents reword or reorder tasks during approved plan revisions?
