# Live harness bridge smoke evidence

- Date: 2026-08-15 (Australia/Perth)
- Presentation: `normal`
- Safety: disposable Git repositories and SWF state, minimal no-tool/no-write prompts, owned Herdr workspaces and panes closed after each run
- Evidence policy: compact pane lines and protocol metadata only; native records and normalized transcripts were not committed

## Results

| Harness | Codec | Result | Capture | Native records | Permissions | Normalized terminal event | Compact completion |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| Pi | `pi-rpc-v1` | completed | healthy | 24 | `0600` | `settled` | `✓ Completed · 3,401 tokens · $0.001 · usage exact` |
| Claude | `claude-stream-json-v1` | completed | healthy | 6 | `0600` | `settled` | `✓ Completed · 22 tokens · $0.066 · usage estimated` |
| Codex | `codex-jsonl-v1` | completed | healthy | 4 | `0600` | `settled` | `✓ Completed · 16,606 tokens · usage exact` |

## Copilot compatibility result

Copilot also completed a live minimal invocation and returned the requested marker. Its result intentionally remains a capability-gap check rather than bridge proof:

- transport: legacy pane transcript;
- structured events: unavailable;
- private protocol capture: unavailable;
- usage quality: unknown;
- marker observed: yes.

This matches the advertised adapter contract: Copilot's programmatic prompt mode does not currently provide a documented stable JSONL protocol. SWF therefore does not claim the normalized settlement, private native capture, or usage guarantees verified above for Pi, Claude, and Codex.

## Protocol and presentation verification

Each invocation ran through its real SWF harness bridge in an owned Herdr pane. The test verified that:

- the adapter and matching Herdr integration were installed and authenticated;
- the invocation settled successfully from normalized events;
- native and normalized cursors advanced;
- the private native stream existed with mode `0600` and contained one or more records;
- metadata reported `captureHealth: healthy`, the expected codec, and effective `normal` presentation;
- pane output contained a compact completion milestone and did not contain raw `{"type"...}` protocol objects;
- only sanitized counts, event-type names, health, permissions, and compact lines were retained here.

Observed normalized event vocabulary included readiness, work start, message summary, usage, completion, and settlement for all three harnesses. Pi additionally emitted prompt acceptance and a bounded diagnostic event. All temporary workspaces, panes, repositories, and protocol files were cleaned after assertion.
