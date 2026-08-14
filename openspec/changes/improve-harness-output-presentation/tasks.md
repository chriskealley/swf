## 1. Normalized Harness Event Model

- [x] 1.1 Define versioned envelopes and event schemas for process, readiness, prompt, work, message, tool, blocked input, usage, retry, compaction, completion, settlement, cancellation, failure, and diagnostics
- [x] 1.2 Include project, run, phase, work unit, invocation, harness, native session, source cursor, timestamp, and usage quality correlation fields
- [x] 1.3 Define adapter codec interfaces for native framing, parsing, normalization, terminal semantics, capability gaps, and optional versus required events
- [x] 1.4 Add stable native-event identities and idempotent normalized-event handling for replay and recovery
- [x] 1.5 Add schema and reducer tests for ordering, correlation, duplicate suppression, unknown optional events, and incompatible required events

## 2. Private Protocol Capture and Bridge Foundation

- [x] 2.1 Pin one compatible Effect v4 beta package set and implement an owned harness bridge process whose Effect services and Layers spawn a native harness with controlled stdin, stdout, stderr, signals, cwd, and environment
- [x] 2.2 Create private invocation metadata, native stream, normalized stream, and cursor files with `0600` permissions under the run raw-output directory
- [x] 2.3 Implement protocol-specific incremental framing with partial-record buffering and Pi-compliant LF semantics that preserve U+2028 and U+2029
- [x] 2.4 Parse native records in memory, apply structural redaction before persistence and display, and retain bounded diagnostics for malformed records
- [x] 2.5 Relay bidirectional commands and native responses without exposing prompts, credentials, or protocol payloads in process titles or pane output
- [x] 2.6 Forward cancellation and termination safely and record bridge processes, files, and ephemeral resources in run ownership
- [x] 2.7 Isolate renderer failure from capture and normalization failure and publish explicit presentation-degraded diagnostics
- [x] 2.8 Add bridge tests for framing, backpressure, partial records, process exit, signals, stderr, permissions, redaction, and renderer degradation
- [x] 2.9 Define Promise-based bridge and lifecycle boundaries for existing scheduler, service, and adapter callers so Effect remains isolated from unrelated packages during migration
- [ ] 2.10 Supervise bridge invocations in service- or run-owned Effect scopes so blocked invocations remain addressable after a scheduler response and close only on settlement, cancellation, cleanup, or shutdown
- [ ] 2.11 Replace manual bridge timeout, polling, retry, and cancellation coordination with Effect schedules, interruption, and exactly-once scoped finalizers
- [ ] 2.12 Add virtual-time lifecycle tests proving normal settlement, blocked-input continuation, timeout cancellation, graceful safe-boundary drain, forced interruption and join, exactly-once finalization, and no late writes after shutdown reconciliation begins

## 3. Pi RPC Codec and Migration

- [x] 3.1 Implement Pi RPC command, response, agent, turn, message, tool, extension UI, retry, compaction, usage, and settlement normalization
- [x] 3.2 Preserve strict request/response correlation and support prompt, blocked-input response, follow-up behavior, abort, and session identity
- [x] 3.3 Require observed work start or explicit terminal native evidence after prompt acceptance so initial idle is never treated as completion
- [x] 3.4 Keep invocations active across low-level `agent_end`, retry, compaction retry, and queued continuation until `agent_settled` or terminal failure
- [x] 3.5 Migrate the Pi adapter from Herdr transcript parsing to bridge normalized-stream consumption
- [x] 3.6 Add fixture and integration tests using real Pi event shapes, repeated partial messages, thinking signatures, tool streams, extension UI events, retries, cancellation, and malformed terminal records

## 4. Claude Code Codec and Migration

- [x] 4.1 Implement Claude stream-json normalization for system/session metadata, assistant messages, tool activity, results, usage, terminal result, failure, and resume identity
- [x] 4.2 Preserve Claude tool allowlists, permission mode, concrete model, cancellation, and resume behavior through the bridge
- [x] 4.3 Investigate whether `--verbose` is required for supported Claude stream-json correctness and remove it only if protocol fixtures prove equivalent required events
- [x] 4.4 Migrate the Claude adapter from pane transcript parsing to bridge normalized-stream consumption
- [x] 4.5 Add fixture and integration tests for normal completion, tool failure, estimated usage, resume, unavailable authentication, cancellation, and protocol-version changes

## 5. Codex CLI Codec and Migration

- [x] 5.1 Implement Codex JSONL normalization for thread/session startup, turns, items, commands, messages, usage, completion, failure, and resume identity
- [x] 5.2 Preserve Codex sandbox, approval policy, cwd, model selection, cancellation, and resume behavior through the bridge
- [x] 5.3 Use native terminal events and process state to distinguish item completion from fully settled invocation completion
- [x] 5.4 Migrate the Codex adapter from pane transcript parsing to bridge normalized-stream consumption
- [x] 5.5 Add fixture and integration tests for normal completion, command output, review or item events, usage, resume, authentication failure, cancellation, and unknown optional events

## 6. Compact Herdr Pane Rendering

- [x] 6.1 Add versioned presentation configuration and precedence for `quiet`, `normal`, `verbose`, and `protocol` levels with `normal` as the generated default
- [x] 6.2 Implement a shared renderer for invocation header, readiness, work, summarized tools, blocked attention, retry, failure, completion, duration, and usage
- [x] 6.3 Add harness-aware summaries for built-in read, write, edit, shell, search, and validation tools without exposing full arguments by default
- [x] 6.4 Collapse repeated partial messages and accumulated tool updates and omit signatures, internal IDs, native objects, and raw thinking outside protocol mode
- [x] 6.5 Bound and redact commands, paths, message text, and tool output in verbose mode and provide explicit retained-output references
- [x] 6.6 Implement quiet rendering with only startup, attention, failure, and final summary milestones
- [x] 6.7 Implement explicit audited protocol rendering of redacted native records with a machine-output warning
- [x] 6.8 Set informative owned pane labels and titles containing change or run, phase, harness, and normalized status
- [x] 6.9 Add semantic renderer tests across Pi, Claude, Codex, custom tools, long output, secrets, retries, failures, and usage-quality variants

## 7. Service Consumption, Progress, and Recovery

- [x] 7.1 Add incremental normalized-stream consumption with durable cursors and bounded polling or private transport
- [x] 7.2 Publish significant normalized milestones through authenticated ordered service events while coalescing high-frequency updates
- [x] 7.3 Build invocation status, usage, evidence summaries, blocked input, and settlement from normalized events rather than pane content
- [ ] 7.4 Reconcile active bridge and harness processes after service restart from durable ownership records, recreate service/run Effect supervision, and resume from the last durable cursor without duplicate milestones
- [x] 7.5 Rebuild missing cursor metadata from framed retained records and durable normalized identities
- [x] 7.6 Fail closed with actionable compatibility evidence when required capture or normalization semantics cannot be recovered
- [ ] 7.7 Integrate normalized progress with CLI and dashboard event consumers when `improve-cli-operator-experience` is available
- [ ] 7.8 Add recovery tests for service restart, bridge survival beyond the prior Effect runtime, missing cursor, duplicate records, truncated trailing records, renderer failure, and missing native files

## 8. Inspection, Retention, and Security

- [ ] 8.1 Add authenticated bounded native-record inspection by invocation and cursor or range with redaction and truncation
- [ ] 8.2 Keep routine status, approval, progress, artifacts, and dossiers on normalized summaries rather than native payloads
- [ ] 8.3 Integrate native and normalized invocation files with preview-and-confirm raw retention and preserve audit markers after pruning
- [ ] 8.4 Ensure portable dossiers exclude native messages, partials, signatures, raw prompts, and tool outputs while retaining conclusions and usage provenance
- [ ] 8.5 Ensure cleanup removes only recorded bridge, pipe, pane, tab, workspace, and ephemeral file resources and retains failed-invocation diagnostics according to policy
- [ ] 8.6 Add security tests for permissions, traversal, symlinks, secret redaction, cross-invocation access, unowned resources, protocol mode auditing, and pruning

## 9. Configuration and Documentation

- [ ] 9.1 Add generated project defaults and documentation for harness presentation levels and raw retention behavior
- [ ] 9.2 Expose effective presentation level, codec version, capture health, cursor, and degradation status through phase and invocation diagnostics
- [ ] 9.3 Update architecture and harness adapter documentation to distinguish native protocol, normalized events, service state, and human presentation
- [ ] 9.4 Update operations and troubleshooting documentation with compact output, verbose inspection, protocol diagnostics, retention, and recovery procedures
- [ ] 9.5 Document adapter requirements for future harness codecs and explicit capability differences

## 10. Acceptance and Release Verification

- [ ] 10.1 Add end-to-end simulated runs proving compact readable panes and complete private capture for Pi, Claude, and Codex
- [ ] 10.2 Verify pane truncation and unrelated pane text cannot alter parsing, settlement, evidence, or usage
- [ ] 10.3 Verify quiet, normal, verbose, and protocol output behavior in TTY and non-TTY Herdr contexts
- [ ] 10.4 Verify blocked input, cancellation, retry, resume, settlement, malformed protocols, service restart, graceful and forced shutdown joining, retention, and cleanup across supported capabilities
- [ ] 10.5 Run formatting, lint, type checking, unit, integration, E2E, OpenSpec validation, and Git whitespace verification
- [ ] 10.6 Perform opt-in live Pi, Claude, and Codex smoke tests where installed and authenticated, retaining compact-output screenshots or text evidence and private protocol verification without committing raw transcripts
