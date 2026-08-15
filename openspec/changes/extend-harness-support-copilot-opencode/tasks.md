## 1. Protocol Baseline and Dependency Boundary

- [ ] 1.1 Record fixture-backed capability matrices for the supported Copilot and OpenCode CLI ranges, including ACP, JSON events, resume, model, permissions, cancellation, settlement, and usage
- [ ] 1.2 Evaluate the compatible ACP TypeScript SDK against SWF framing, cancellation, permission, session-load, and Effect lifecycle requirements and document the keep-or-minimal-client decision
- [ ] 1.3 Pin any selected ACP dependency and isolate its public types behind SWF-owned Promise-based bridge interfaces
- [ ] 1.4 Define versioned transport descriptor schemas for `acp`, `json-events`, and `legacy-transcript`, including harness version, protocol version, codec version, negotiated capabilities, and degradation reasons
- [ ] 1.5 Add schema and compatibility tests for valid descriptors, unsupported versions, missing required capabilities, and persisted descriptor round trips

## 2. Harness Discovery and Transport Negotiation

- [ ] 2.1 Extend harness identifiers, requirement metadata, setup diagnostics, adapter factories, and generated schemas to include optional `opencode`
- [ ] 2.2 Implement bounded non-mutating Copilot and OpenCode version/protocol probes without starting agent work or reading credential files
- [ ] 2.3 Implement deterministic OpenCode transport selection in ACP then documented JSON-events preference order
- [ ] 2.4 Implement deterministic Copilot transport selection in ACP then documented JSONL then legacy-transcript preference order
- [ ] 2.5 Persist the selected transport descriptor before launch and reject probe/runtime negotiation mismatches without switching transport mid-invocation
- [ ] 2.6 Validate phase-required capabilities against the selected transport before creating Herdr resources and return actionable upgrade or configuration diagnostics
- [ ] 2.7 Add discovery tests for absent executables, supported and unsupported versions, authentication failures, protocol mismatches, fallback selection, and required-capability rejection

## 3. ACP Bridge Transport

- [ ] 3.1 Implement incremental ACP newline-delimited JSON framing with partial-record buffering, bounded malformed-record diagnostics, and protocol-only stdout handling
- [ ] 3.2 Implement ACP initialization and negotiated capability capture for Copilot and OpenCode server commands
- [ ] 3.3 Implement correlated new-session, load-session, prompt, session-update, and terminal prompt-response handling
- [ ] 3.4 Implement ACP permission request mediation through resolved SWF tool and approval policy with audited automatic, denied, and blocked-input outcomes
- [ ] 3.5 Implement ACP cancellation followed by bounded graceful shutdown and scoped owned-process interruption
- [ ] 3.6 Persist both ACP directions with `0600` permissions, structural redaction, source cursors, request/session identities, and bounded indexes
- [ ] 3.7 Run each ACP invocation in a service- or run-owned Effect scope with interruption, timeout schedules, exactly-once finalizers, and no late writes after reconciliation
- [ ] 3.8 Add protocol tests for chunked frames, concurrent requests, unknown notifications, incompatible required responses, malformed terminal frames, stderr, backpressure, process exit, and signal forwarding
- [ ] 3.9 Add virtual-time lifecycle tests for settlement, blocked permissions, cancellation grace expiry, bridge survival, forced shutdown, and exactly-once cleanup

## 4. Copilot and OpenCode Normalization

- [ ] 4.1 Implement a versioned ACP normalization layer for initialization, session identity, messages, plans, tool activity, permission requests, errors, stop reasons, cancellation, completion, and settlement
- [ ] 4.2 Implement an OpenCode JSON-events codec using documented real event fixtures and explicit required-versus-optional native event classification
- [ ] 4.3 Implement a Copilot JSONL codec only for a documented supported output contract and keep it disabled for versions that do not advertise that contract
- [ ] 4.4 Preserve stable native identities and suppress duplicate normalized milestones during replay and restart recovery
- [ ] 4.5 Require a correlated terminal prompt response or documented terminal event plus compatible process state before settlement
- [ ] 4.6 Normalize attributable structured tokens and cost with exact or estimated provenance and leave aggregate or textual usage unknown
- [ ] 4.7 Add normalization fixtures for messages, partials, parallel tools, permission choices, failures, cancellation, session resume, usage variants, unknown optional events, and incompatible required events

## 5. OpenCode Adapter

- [ ] 5.1 Add `OpenCodeHarnessAdapter` with negotiated capabilities, model selection, session continuation, cancellation, and transport-specific launch arguments
- [ ] 5.2 Route OpenCode ACP invocations through the shared bridge and support durable session loading for follow-up prompts
- [ ] 5.3 Add the documented `opencode run --format json` structured fallback with session identity and terminal semantics
- [ ] 5.4 Map OpenCode permissions conservatively without enabling dangerous auto-approval unless resolved SWF policy explicitly authorizes equivalent access
- [ ] 5.5 Register OpenCode in scheduler/service adapter maps, model routing, doctor output, CLI selection, generated examples, and E2E harness selection
- [ ] 5.6 Add adapter unit and integration tests for launch, resume, model routing, permissions, usage quality, cancellation, failures, and both transport paths

## 6. Copilot Structured Upgrade and Compatibility

- [ ] 6.1 Refactor the existing Copilot adapter to consume a persisted transport descriptor rather than static transcript-only capabilities
- [ ] 6.2 Route supported Copilot ACP invocations through the shared bridge with session creation/loading, permission mediation, cancellation, and settlement
- [ ] 6.3 Route supported documented Copilot JSONL invocations through the private bridge and versioned codec
- [ ] 6.4 Preserve model, custom agent, allow/deny tool, path, resume, and environment behavior across structured launch and follow-up commands
- [ ] 6.5 Retain legacy transcript behavior for compatible phases while explicitly disabling structured events, durable settlement, adoption, blocked input, and usage claims
- [ ] 6.6 Add Copilot tests across old transcript-only versions, ACP-capable versions, JSONL-capable versions, missing authentication, protocol mismatch, resume, permissions, cancellation, and fallback diagnostics

## 7. Service Recovery, Presentation, and Inspection

- [ ] 7.1 Extend invocation ownership and adoption to ACP processes, protocol descriptors, session metadata, and durable cursors
- [ ] 7.2 Reconcile active Copilot and OpenCode bridges after service restart without duplicate updates or premature settlement
- [ ] 7.3 Extend the shared renderer with bounded Copilot and OpenCode message, tool, permission, failure, completion, duration, transport, and usage summaries
- [ ] 7.4 Mark legacy Copilot panes and diagnostics as degraded without exposing protocol payloads or treating presentation as workflow authority
- [ ] 7.5 Extend authenticated native-output inspection and retention pruning to ACP and vendor JSON codecs while excluding raw protocol from portable dossiers
- [ ] 7.6 Add recovery and presentation tests for restart, missing cursors, duplicate records, truncated trailing frames, renderer failure, pruning, and legacy fallback

## 8. Configuration, Documentation, and Migration

- [ ] 8.1 Add OpenCode model-tier mappings and examples while preserving explicit harness-default and fallback policy
- [ ] 8.2 Document effective transport selection, supported version ranges, capability differences, authentication, permissions, resume, settlement, usage provenance, and upgrade guidance
- [ ] 8.3 Update architecture, harness adapter, operations, and troubleshooting documentation for ACP, OpenCode, and structured-versus-legacy Copilot
- [ ] 8.4 Update initialization and doctor snapshots so absent optional harnesses do not fail baseline readiness and selected incompatible harnesses do fail preflight
- [ ] 8.5 Add migration notes confirming existing Copilot configuration remains valid and explaining how to require structured transport explicitly

## 9. Security and End-to-End Verification

- [ ] 9.1 Add security tests for ACP permission escalation, path/tool policy boundaries, secret redaction, symlinks, traversal, cross-invocation access, and unowned processes
- [ ] 9.2 Add simulated E2E runs proving OpenCode ACP/JSON and Copilot ACP/JSON settle from private structured events with compact panes
- [ ] 9.3 Extend simulated E2E coverage proving legacy Copilot fallback is capability-limited and cannot satisfy structured-event or durable-settlement requirements
- [ ] 9.4 Verify blocked permission response, cancellation, resume, malformed protocols, service restart, graceful/forced shutdown, retention, and cleanup across both harnesses
- [ ] 9.5 Verify pane truncation and unrelated pane text cannot alter parsing, evidence, usage, permission correlation, or settlement for structured transports

## 10. Live Compatibility and Final Checks

- [ ] 10.1 Run an opt-in live OpenCode smoke through the preferred ACP transport and verify native capture permissions, normalized milestones, session identity, settlement, and compact output
- [ ] 10.2 Run an opt-in live OpenCode JSON-events fallback smoke and verify the declared capability differences
- [ ] 10.3 Run an opt-in live structured Copilot smoke against a compatible installed version and verify negotiated transport, private capture, permissions, session identity, settlement, and usage provenance
- [ ] 10.4 Run an opt-in live legacy Copilot smoke against the currently supported fallback and verify explicit degradation without false structured claims
- [ ] 10.5 Record validated harness versions, transport descriptors, redacted smoke evidence, and any deferred compatibility gaps without committing raw transcripts
- [ ] 10.6 Run formatting, lint, type checking, unit, integration, E2E, strict OpenSpec validation, and Git whitespace verification
