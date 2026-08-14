## Context

SWF is a service-owned stateful workflow, but the CLI currently behaves as a thin request/response wrapper. Default output pretty-prints raw objects, workflow commands remain silent while synchronous work runs, lifecycle commands require internal IDs, and approval commands return only `{ accepted: true }`. The service already owns durable events, run reconstruction, phase and gate state, evidence, SSE continuation, checkpoints, delivery, and authentication; the missing layer is an explicit operator projection and clients designed around it.

The live source-based acceptance exercise demonstrated the consequences: command substitution hid progress, `blocked` did not explain approval, operators had to extract project and run IDs and know the gate ID, phase results did not always identify the actual stopping phase, and successful approval did not explain what became possible next.

## Goals / Non-Goals

**Goals:**
- Make every human CLI command answer “what happened?” and “what should I do next?”
- Give all clients one service-owned interpretation of attention and permitted next actions.
- Keep ordinary commands change-oriented while retaining explicit identifiers for advanced use.
- Stream useful bounded progress without requiring a full-screen TUI.
- Preserve deterministic, script-safe JSON and non-interactive behavior.
- Improve failure messages without weakening fail-closed policy or durable state semantics.

**Non-Goals:**
- Replacing the dashboard or building a full-screen terminal application.
- Changing workflow phase, gate, approval, checkpoint, delivery, or authorization semantics.
- Letting the CLI become a second scheduler or infer authority independently of the service.
- Automatically approving gates or choosing among ambiguous operator actions.
- Including raw transcripts in routine terminal output.

## Decisions

### 1. Add a service-owned operator projection

The service will derive a versioned projection from reconstructed run state and resolved configuration. It will contain a concise summary, current/stopping phase, typed attention items, evidence references, allowed semantic actions, and a recommended action. Mutating command responses will include the resulting projection rather than only request acceptance.

This keeps CLI, Pi, and dashboard consistent and preserves the service as sole workflow authority. A client-only interpretation was rejected because each client would eventually disagree about blocked states, action validity, and stopping phases.

```text
Durable events + configuration + evidence
                  │
                  ▼
        Operator projection
        ├── summary
        ├── attention[]
        ├── allowedActions[]
        └── recommendedAction
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
      CLI         Pi      Dashboard
```

The projection is rebuildable and not a new source of truth. If cached later, the cache remains disposable.

### 2. Keep actions semantic and render commands at the edge

Service actions will identify an action type and the references/inputs needed to execute it. They will not make shell command strings authoritative. The CLI maps semantic actions to commands, the dashboard maps them to controls, and Pi maps them to tools or slash commands.

Actions are advisory snapshots. The service revalidates current state on mutation and returns current guidance when an action has become stale.

### 3. Separate human, JSON, and stream presentation

The CLI will have three presentation paths:

- Human TTY: bounded progress plus a structured final summary.
- Human non-TTY: line-oriented milestones and final summary without animation.
- JSON: one versioned JSON document and no prompts or progress on stdout.

Rendering functions will consume typed projections rather than arbitrary unknown response objects. Detailed IDs and diagnostics belong under `--verbose` or JSON.

Progress will use the existing ordered SSE stream and sequence continuation. Ephemeral visual state may be client-owned; completed milestones derive from durable events so reconnect is safe.

### 4. Make change name the primary operator selector

Common commands will accept a positional change name and resolve:

```text
cwd → initialized project → project ID
change name → bound run ID
attention type → phase/gate/invocation IDs
```

Explicit `--project`, `--run`, `--phase`, and `--gate` options remain available. Shorthand succeeds only when resolution is unique; ambiguity produces choices rather than a guess.

This is an additive migration. Existing automation using explicit IDs remains valid.

### 5. Make interaction optional and conservative

TTY mode may offer an inline decision menu when attention is required, but the default safe exit remains leaving the run blocked. `--no-interactive`, JSON mode, non-TTY input/output, and CI environments never prompt. Approval still requires an explicit operator decision and actor record.

### 6. Classify failures at the service boundary

Errors and projections will use stable categories such as configuration, dependency, infrastructure, harness, work, check, policy, budget, and delivery. Classification describes origin and recovery; it does not erase the underlying durable event or error detail.

Human output shows a concise cause and recovery action. JSON includes code, category, resulting run state when known, diagnostic references, and semantic recovery actions.

### 7. Treat progress and final state as separate concerns

Progress events improve confidence but do not determine success. At command completion, the CLI queries or receives the final operator projection and renders from durable state. Losing the progress stream must not alter execution or final reporting.

## Risks / Trade-offs

- **Projection logic becomes another domain layer** → Keep it pure, versioned, rebuildable, and comprehensively test it against event-state fixtures.
- **Human rendering can drift from JSON semantics** → Generate both from shared typed projection/action models and contract-test representative states.
- **TTY progress may become noisy** → Render only phase/work/check/gate/checkpoint/delivery milestones and place event-level detail behind `--verbose`.
- **Interactive prompts can surprise scripts** → Require TTY input and output, disable in JSON/non-TTY modes, support `--no-interactive`, and default to no mutation.
- **Shorthand may hide ambiguity** → Resolve only unique matches and display explicit alternatives otherwise.
- **Command responses can race with subsequent state changes** → Treat actions as advisory and revalidate all mutations service-side.
- **Adding action data may expand API contracts** → Add versioned fields compatibly and retain existing low-level state queries.
- **SSE reconnection may replay visual events** → Track sequence IDs and render durable milestones idempotently.

## Migration Plan

1. Introduce versioned operator projection and semantic action schemas without changing existing command inputs.
2. Add service queries and command response projection while preserving existing response fields during migration.
3. Add shared CLI resolution and rendering layers, then convert workflow and lifecycle commands incrementally.
4. Add TTY/non-TTY progress consumption using existing SSE continuation.
5. Add change-name shorthand while preserving explicit ID forms and documenting ambiguity behavior.
6. Expose the same projection to Pi and dashboard clients.
7. Update documentation and acceptance tests around the human journey.

Rollback can retain the new additive service fields while reverting clients to low-level output. No durable event migration is required unless projection-relevant data gaps are discovered; any such gap must be added as new events rather than rewriting history.

## Open Questions

- Should interactive approval be enabled by default for TTY workflow commands, or require an explicit `--interactive` flag initially?
- Should `swf status <change>` replace the explicit-ID form in help ordering while retaining both syntaxes, or should a new `swf show <change>` command provide the operator projection?
- Should human progress go to stderr so stdout can remain capture-friendly even without `--json`, or should only JSON mode promise a clean data channel?
- How much risk and evidence detail belongs in the default approval summary before requiring `--verbose` or an inspection command?
