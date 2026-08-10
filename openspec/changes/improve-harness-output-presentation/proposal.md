## Why

SWF launches Pi, Claude Code, and Codex CLI in structured machine modes but exposes their raw JSON or JSONL protocols directly in Herdr panes. Those streams contain repeated partial messages, tool payloads, usage objects, thinking signatures, and protocol metadata intended for parsers, making live execution difficult for operators to follow and coupling adapter correctness to terminal transcript scraping.

## What Changes

- Separate each harness's complete machine protocol channel from its human-visible Herdr pane presentation.
- Normalize Pi RPC, Claude stream-json, Codex JSONL, and future adapter events into a shared SWF harness lifecycle model.
- Render compact, regular-session-like milestones in owned Herdr panes instead of raw protocol objects.
- Add `quiet`, `normal`, `verbose`, and diagnostic `protocol` presentation levels with safe defaults and configuration provenance.
- Persist complete raw protocol streams privately for parsing, usage accounting, diagnostics, recovery, and retention without placing them in portable dossiers.
- Make adapters consume framed raw event streams or normalized durable events rather than scraping the rendered pane transcript.
- Preserve cancellation, blocked input, follow-up, settlement detection, session identity, tool tracking, usage, and recovery behavior across harnesses.
- Bound, redact, and correlate displayed tool activity while keeping full authorized output available through explicit inspection.
- Integrate normalized harness milestones with service events and the operator-progress work proposed by `improve-cli-operator-experience` without making terminal presentation authoritative for workflow state.

## Capabilities

### New Capabilities
- `harness-event-normalization`: Cross-harness lifecycle, message, tool, usage, blocked-input, retry, and settlement semantics derived from native Pi, Claude, and Codex machine protocols.
- `harness-pane-presentation`: Compact configurable Herdr pane rendering for harness execution with bounded milestones, summaries, failures, and usage.
- `harness-protocol-retention`: Private framed raw-protocol capture, adapter consumption, redaction, correlation, recovery, inspection, and retention independent of human terminal output.

### Modified Capabilities

None. The repository does not yet contain archived main capability specs for harness presentation or protocol transport.

## Impact

- Affects core harness event types, adapter interfaces, Pi/Claude/Codex launch commands, Herdr execution, invocation observation, collection, cancellation, and recovery.
- Adds a bridge or equivalent transport between harness subprocesses, private raw event storage, SWF normalization, and compact terminal rendering.
- Affects invocation artifacts, usage accounting, retention, redaction, service event streaming, diagnostics, and live harness acceptance tests.
- May consume the shared operator projection and progress presentation introduced by `improve-cli-operator-experience`, but remains independently useful for Herdr pane readability.
- Does not replace native machine protocols, weaken audit retention, expose raw thinking signatures, or make pane text a source of workflow truth.
