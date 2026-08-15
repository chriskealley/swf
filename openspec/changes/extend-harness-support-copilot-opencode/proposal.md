## Why

SWF already exposes GitHub Copilot as a limited transcript-based adapter, while OpenCode is not selectable despite exposing structured JSON and ACP interfaces. Extending the harness through a reusable Agent Client Protocol transport gives both tools durable lifecycle semantics and lets experimental users choose them without weakening the capture, recovery, and presentation guarantees established for Pi, Claude, and Codex.

## What Changes

- Add OpenCode as an optional selectable harness across schemas, setup diagnostics, model routing, adapter registration, documentation, and smoke coverage.
- Add a reusable, versioned ACP client transport to the existing private harness bridge for harnesses that expose a compatible ACP server.
- Upgrade Copilot to structured operation when a supported ACP or JSONL interface is available, while retaining an explicit capability-limited transcript fallback for older CLI versions.
- Implement Copilot and OpenCode normalization for sessions, messages, tool activity, permission or blocked-input requests, usage where available, failures, cancellation, completion, and settlement.
- Preserve harness-specific model, tool/permission, resume, authentication, and usage-quality distinctions rather than claiming false parity.
- Add capability probing and protocol negotiation that fail before execution when a phase requires semantics unavailable from the installed harness version.
- Extend compact pane presentation, private protocol retention, restart adoption, fixtures, and opt-in live smoke tests to both harnesses.

## Capabilities

### New Capabilities

- `acp-harness-transport`: Version negotiation, session lifecycle, permission exchange, cancellation, framing, and recovery for harnesses driven through Agent Client Protocol.

### Modified Capabilities

- `factory-project-configuration`: Recognize OpenCode as an optional harness and diagnose installed-version, authentication, protocol, and capability readiness for both OpenCode and Copilot.
- `harness-event-normalization`: Normalize Copilot and OpenCode native/ACP events with explicit settlement, usage quality, and capability gaps.
- `harness-pane-presentation`: Present Copilot and OpenCode execution with the same compact, safe milestone vocabulary used by existing structured harnesses.
- `harness-protocol-retention`: Capture and recover ACP or JSONL machine channels independently from pane text, including version-gated Copilot fallback behavior.

## Impact

- Affects core harness schemas, requirements, protocol descriptors, codecs, reducers, bridge lifecycle, service recovery, model routing, and diagnostics.
- Adds an OpenCode integration adapter and upgrades the Copilot adapter while preserving compatibility with older Copilot installations.
- Extends Herdr launch/adoption behavior, generated configuration, CLI documentation, fixtures, integration tests, E2E tests, and live smoke tests.
- May add an ACP protocol package or a small internal typed client; any dependency must be pinned and isolated behind the existing Promise-based bridge boundary.
- Does not make Copilot or OpenCode required dependencies and does not treat experimental or undocumented output as a durable contract without explicit version gating.
