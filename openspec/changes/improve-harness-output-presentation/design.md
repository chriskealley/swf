## Context

SWF requires structured harness modes for reliable lifecycle observation, usage accounting, cancellation, blocked input, and recovery. Pi provides LF-delimited RPC events, Claude Code provides `stream-json`, and Codex CLI provides JSONL with `exec --json`. Those modes are designed for a client, not a person.

Today SWF starts those commands directly in Herdr panes and later reads pane transcripts to recover structured events. This conflates three different concerns:

```text
machine protocol = parser input = human terminal output
```

The result is unreadable panes containing repeated partial message objects, tool payloads, encrypted thinking signatures, and usage metadata. It also makes correctness vulnerable to terminal wrapping, scrollback truncation, shell prompts, unrelated pane text, and presentation changes. The live Pi run already exposed timing and protocol assumptions around empty command responses and initial idle state.

The design must preserve Herdr as the owned process substrate, the service as workflow authority, private redacted raw retention, harness-native capabilities, and existing previewed retention behavior.

## Goals / Non-Goals

**Goals:**
- Keep native structured protocols for machine correctness while making Herdr panes readable.
- Give Pi, Claude, and Codex a common normalized lifecycle without erasing real capability differences.
- Stop parsing the human-visible terminal as the machine protocol channel.
- Retain complete redacted native records privately for recovery and diagnostics.
- Support quiet, normal, verbose, and explicit protocol presentation.
- Preserve prompt submission, follow-up, blocked input, cancellation, usage, settlement, and session identity.

**Non-Goals:**
- Replacing the native Pi, Claude, or Codex interactive applications.
- Making every harness expose capabilities it does not natively support.
- Treating compact pane output as durable workflow evidence.
- Committing raw native streams or thinking data to Git dossiers.
- Removing detailed diagnostics; they move behind explicit inspection and protocol mode.
- Building a full-screen SWF TUI.

## Decisions

### 1. Introduce an SWF harness bridge

Each owned harness command will run through an SWF bridge inside its Herdr pane. The bridge owns the native subprocess and separates its streams:

```text
                 SWF harness bridge
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
 native harness     private files      pane stdout
 stdin/stdout       raw + normalized    compact renderer
        │                │                │
        ▼                ▼                ▼
 Pi/Claude/Codex    service adapter      operator
```

For bidirectional Pi RPC, the bridge relays strict LF-framed commands and responses. For Claude and Codex one-shot streams, it captures process output and preserves native session/resume references. Signals and cancellation are forwarded according to adapter capabilities.

The bridge pre-creates private invocation files, records its process as an owned resource, and receives invocation metadata through arguments or a private descriptor. Prompts and credentials should not be exposed in pane titles or process arguments when the native harness supports stdin or private control input.

A shell `tee | jq` pipeline was rejected because it cannot provide robust framing, ownership, redaction, bidirectional control, normalized indexes, renderer degradation handling, or cross-platform process semantics.

### 2. Store raw and normalized streams separately

Each invocation receives bounded metadata and append-only streams under its private run state:

```text
.swf-state/runs/<run-id>/
└── raw/invocations/<invocation-id>/
    ├── metadata.json
    ├── native.jsonl
    ├── normalized.jsonl
    └── cursor.json
```

Files are mode `0600`; parent directories remain private. Native records are framed according to the harness protocol, parsed where possible, structurally redacted, and then retained. Unknown or malformed data is retained only as bounded redacted diagnostic material.

`normalized.jsonl` is the service-facing channel. It contains stable source identities or cursors so recovery can replay idempotently. Cursor metadata is an optimization and can be rebuilt from retained records and durable service events.

The portable dossier includes compact invocation conclusions, model/harness identity, normalized usage, and evidence references—not native streams, partial messages, or thinking signatures.

### 3. Define a common event model with explicit capability gaps

A normalized event envelope carries project, run, phase, work unit, invocation, harness, native session, source cursor, timestamp, and event-specific data.

Representative events:

```ts
HarnessEvent =
  | processStarted
  | ready
  | promptAccepted
  | workStarted
  | messageSummary
  | toolStarted
  | toolProgress
  | toolCompleted
  | blocked
  | usage
  | retryStarted
  | retryCompleted
  | compactionStarted
  | compactionCompleted
  | completed
  | settled
  | cancelled
  | failed
  | diagnostic
```

Adapters map native records to this model through version-aware codecs. The common schema allows optional native references and usage quality. It does not pretend Claude or Codex supports Pi-style blocked input, or that every harness has exact cost data.

High-frequency deltas are retained natively but coalesced before durable service publication and human rendering.

### 4. Make settlement explicit

The normalizer distinguishes:

```text
process ready
    │
prompt accepted
    │
work started
    │
turn or item completed
    │
retry/compaction/follow-up pending?
    ├── yes ──▶ remain active
    └── no ───▶ settled
```

Initial Herdr idle state after prompt submission is not completion. Pi requires `agent_settled` or equivalent terminal evidence after observed start. Claude and Codex mappings use their terminal result/process semantics plus pending continuation state. Unknown required terminal shapes fail closed with protocol diagnostics.

### 5. Render normalized events, never native objects

The bridge feeds normalized events into a renderer configured as:

| Level | Intended output |
|---|---|
| `quiet` | Start, attention/failure, completion, duration, usage |
| `normal` | Phase and summarized tool milestones plus final result |
| `verbose` | Bounded commands, paths, and truncated results |
| `protocol` | Explicit diagnostic display of redacted native records |

`normal` is the generated default.

Example:

```text
Planning · Pi · reasoning tier

  ✓ Read OpenSpec and project context
  ✓ Wrote 6 planning artifacts
  ✓ OpenSpec validation passed

Completed in 2m 41s · 21,282 tokens · $0.021
```

Renderers remove repeated partial snapshots, internal protocol IDs, encrypted thinking signatures, full message objects, and unbounded tool output. Tool arguments are summarized by harness-aware rules; unknown tools receive a generic bounded description. Explicit inspection remains available through authenticated raw-output APIs.

### 6. Keep presentation disposable and failure-isolated

The service adapter tails or incrementally reads the normalized stream, not pane output. Presentation can be cleared, truncated, recolored, or changed without affecting execution. A renderer error produces a presentation-degraded diagnostic and falls back to quiet milestones where possible; it does not fail otherwise healthy harness work.

Conversely, capture or normalization failure is operationally significant because machine correctness depends on it. The service fails closed if required lifecycle records cannot be established.

### 7. Integrate normalized milestones with service progress

Significant normalized events are projected into the existing authenticated ordered event stream. CLI and dashboard progress can consume the same common milestones, while Herdr panes render locally from the bridge.

```text
normalized event
      │
      ├──▶ compact Herdr pane
      ├──▶ durable invocation state
      ├──▶ ordered service progress
      └──▶ usage/evidence aggregation
```

This complements `improve-cli-operator-experience`: that change explains workflow attention and next actions; this change explains what an active harness is doing. Neither client derives workflow truth from visual output.

### 8. Preserve harness-specific controls

Pi bridge mode remains bidirectional for prompt, steer/follow-up where used, abort, extension UI requests, and settlement. Claude and Codex retain their native one-shot and resume mechanisms. Adapter capability declarations continue to determine which normalized actions are valid.

Native launch options are reviewed for avoidable verbosity. For example, Claude's explicit `--verbose` should be retained only if required for correct stream semantics in the supported installed version. Removing a flag is not considered a substitute for channel separation.

### 9. Retention and inspection remain explicit

Native files participate in existing raw retention previews and confirmation. Pruning preserves normalized milestones, invocation state, usage, final summaries, cursors needed to identify terminal state, and audit markers that native output is unavailable.

Authenticated inspection supports bounded invocation/cursor ranges and redaction. Protocol display is opt-in, audited, and never the default troubleshooting recommendation when normalized diagnostics suffice.

## Risks / Trade-offs

- **Bridge adds another process and failure surface** → Keep it small, dependency-light, owned, health-reported, and covered by live protocol fixtures.
- **Harness protocols evolve** → Version codecs, preserve unknown events natively, distinguish optional from required shapes, and fail closed on terminal ambiguity.
- **Inline redaction can affect protocol fidelity** → Parse and normalize in memory first, structurally redact persisted values, and retain bounded metadata for parser diagnostics.
- **High-frequency streams can consume storage** → Coalesce normalized updates, retain raw streams under configurable retention, and preserve existing previewed pruning.
- **Rendering may hide useful debugging detail** → Provide verbose presentation and explicit bounded raw inspection without making protocol mode routine.
- **Tool summaries can be misleading** → Use conservative verbs, display failure clearly, and link to retained output rather than inventing semantic success.
- **Service restart may lose a pipe** → Persist bridge ownership and cursors, reconcile the native process, and design capture endpoints for reconnect or deterministic failure.
- **Prompt relay through a PTY can corrupt framing** → The bridge owns child pipes directly and implements protocol-specific framing; the pane is only the bridge UI/control host.
- **Claude/Codex one-shot behavior differs from Pi** → Preserve differences in codec and capability metadata instead of forcing a false persistent-session abstraction.

## Migration Plan

1. Define normalized schemas, codec contracts, stream metadata, cursors, and presentation configuration additively.
2. Implement the bridge and fixture-driven codecs without changing default adapter launches.
3. Migrate Pi first because it has the strictest bidirectional framing and noisiest stream; validate blocked input, cancellation, retry, and settlement.
4. Migrate Claude stream-json and Codex JSONL while preserving resume and usage semantics.
5. Switch service adapters from transcript parsing to normalized stream consumption.
6. Enable `normal` compact pane presentation for new invocations, retaining an explicit protocol diagnostic fallback.
7. Integrate normalized milestones with service progress and raw retention inspection.
8. Remove obsolete transcript-parsing assumptions after all adapters and acceptance tests pass.

Rollback can restore direct harness commands and transcript parsing for a supported adapter while leaving additive retained normalized files readable. No existing durable events need rewriting.

## Open Questions

- Should the bridge expose a private Unix socket for immediate normalized events, or should the service follow append-only normalized files with platform-safe polling?
- Which normalized milestones must be durably appended versus published ephemerally to avoid excessive event logs?
- Should protocol presentation be allowed per invocation only, or also as a project default despite its poor human ergonomics?
- How should compact rendering summarize custom extension tools whose semantics SWF does not know?
