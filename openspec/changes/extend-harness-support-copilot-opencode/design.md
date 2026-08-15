## Context

SWF currently has structured bridge codecs for Pi RPC, Claude stream-json, and Codex JSONL. GitHub Copilot is registered but uses pane transcript observation, which cannot provide durable event cursors, reliable settlement, restart adoption, or trustworthy usage. OpenCode is not registered, although the installed `1.17.10` CLI exposes `run --format json`, session continuation, a headless server, and an ACP server over newline-delimited JSON. Current GitHub documentation also defines a Copilot ACP server and an experimental JSONL output mode, but the installed Copilot `0.0.358` predates those interfaces.

Both newer harnesses therefore fit the existing private bridge model, but installed versions differ materially. The implementation must negotiate a supported transport before launching work, retain the selected contract in invocation metadata, and never infer capabilities merely from the harness name.

## Goals / Non-Goals

**Goals:**

- Make OpenCode a first-class optional harness and raise supported Copilot versions to structured operation when possible.
- Reuse one ACP session driver, framing layer, and normalization boundary for any compatible harness.
- Preserve the existing private capture, Effect-owned lifecycle, restart adoption, settlement, redaction, and compact presentation guarantees.
- Select a transport from observed version and protocol capabilities, record that selection durably, and validate phase requirements before Herdr resources are created.
- Retain a clearly degraded Copilot transcript fallback for older installations and a structured OpenCode JSON-events fallback when ACP is unavailable or incompatible.
- Represent model, tool/permission, blocked-input, resume, usage, and cost differences honestly.

**Non-Goals:**

- Reverse-engineer private Copilot or OpenCode storage, terminal rendering, or undocumented event shapes.
- Require either optional harness for baseline SWF installation.
- Force ACP onto Pi, Claude, or Codex while their existing native transports remain appropriate.
- Treat text from `/usage`, pane decorations, logs, or OpenTelemetry export as authoritative usage unless a separately versioned structured contract is implemented.
- Guarantee identical tools, permissions, model names, or accounting across harnesses.

## Decisions

### 1. Prefer ACP through the existing harness bridge

Add an ACP transport driver inside the bridge boundary. It will spawn `copilot acp` or `opencode acp`, perform ACP initialization, negotiate protocol capabilities, create or load a session, submit prompts, process session updates and permission requests, cancel work, and close the child process through the existing Effect scope and finalizers.

The implementation should use a pinned compatible ACP TypeScript SDK if its framing and cancellation behavior can be integrated without leaking runtime concerns into scheduler or adapter packages. Otherwise, a minimal internal typed client may implement only the negotiated ACP methods used by SWF. In either case, the rest of SWF sees Promise-based bridge operations and normalized events.

Alternatives considered:

- Separate Copilot and OpenCode protocol clients duplicate session, permission, cancellation, and recovery logic.
- Driving the interactive TUI through Herdr preserves visual compatibility but cannot be durable workflow authority.
- Using a shared long-running HTTP server adds port, authentication, ownership, and cross-run isolation complexity that stdio ACP does not require.

### 2. Negotiate and persist transport capabilities before execution

Availability diagnostics will inspect the executable version and perform a bounded, non-mutating protocol probe where needed. The resulting descriptor includes harness version, transport (`acp`, `json-events`, or `legacy-transcript`), protocol/codec version, session load support, permission support, cancellation, structured events, model selection, tool policy, and usage quality.

The selected descriptor is written to invocation metadata before launch. A running invocation never silently switches transport. If initialization proves the probe wrong, the invocation fails with compatibility diagnostics; a subsequent retry may select another configured transport after validation.

OpenCode selection order is ACP, then documented `run --format json`. Copilot selection order is ACP, then documented/version-gated JSONL output, then the existing transcript path. Legacy Copilot remains usable only for phases whose required capability set it satisfies, and diagnostics prominently identify its settlement and recovery limitations.

Alternatives considered:

- Static capabilities keyed only by adapter produce false claims across CLI versions.
- Falling back during an active invocation can duplicate work and corrupt settlement evidence.

### 3. Normalize ACP and vendor JSON without erasing source semantics

ACP initialization, session updates, message chunks, tool calls, plans, permission requests, prompt responses, stop reasons, and errors are retained as native records and mapped to the common event schema. Vendor JSON codecs handle only documented, fixture-backed event shapes not represented by ACP. Native method/type, protocol version, session ID, request ID, and source cursor remain available as bounded adapter references.

A completed tool or message is not invocation settlement. Settlement requires a correlated terminal prompt response/stop reason or a documented terminal JSON event plus compatible process state. Unknown required terminal shapes fail closed; unknown optional updates are retained and skipped with diagnostics.

Usage is exact or estimated only when the selected structured protocol provides attributable numeric fields with documented meaning. Otherwise it remains unknown. Copilot `/usage` text and aggregate OpenCode `stats` are not assigned to a single invocation.

### 4. Map ACP permissions into SWF blocked-input and policy behavior

ACP permission requests are checked against the resolved phase tool and approval policy. Requests already authorized by policy are answered automatically and audited; requests requiring operator choice emit a normalized blocked-input event with bounded choices and remain supervised. Denied or unsupported requests produce explicit normalized outcomes.

Prompts, permission payloads, tool arguments, and results pass through structural redaction before persistence or presentation. Default launch flags remain least-privilege; the adapter must not use OpenCode's dangerous permission bypass or Copilot's allow-all modes unless resolved project policy explicitly authorizes equivalent access.

### 5. Treat an ACP server as an owned per-invocation resource

Each active invocation owns its ACP child process, stdin/stdout channel, protocol directory, and session metadata. The bridge may outlive a service process and continues writing durable records. On service restart, SWF adopts the bridge and resumes normalized consumption from the durable cursor. Cancellation is sent through ACP when supported, followed by scoped process termination if the protocol does not settle within the configured grace period.

After a settled turn, the ACP process is closed and the native session identifier is retained. Follow-up work starts a new owned bridge and loads the session when the harness advertises that capability. OpenCode JSON fallback uses `--session`; Copilot fallback uses its documented resume interface.

### 6. Add OpenCode through the same adapter registration surfaces

`opencode` becomes a valid harness identifier in Zod schemas, requirements, setup diagnostics, adapter factories, model mappings, generated examples, and E2E selection. Its adapter advertises only capabilities returned by transport negotiation. Authentication diagnostics use supported non-mutating provider/session commands where available and otherwise return actionable launch-time diagnostics without reading credential files.

Copilot retains its existing identifier and configuration compatibility. No project migration is required unless a project wants OpenCode routes or wants to require structured Copilot semantics.

### 7. Test contracts with fixtures first and live smokes second

Protocol fixtures cover ACP initialization, new/load session, assistant chunks, tool lifecycles, permission choices, cancellation, stop reasons, malformed frames, unknown methods, duplicate replay, and process loss. Vendor JSON fixtures cover OpenCode and Copilot event modes independently. Integration tests exercise bridge capture, permissions, adoption, renderer isolation, and fallback selection. Opt-in live smokes run a harmless marker task through installed/authenticated Copilot and OpenCode and retain only redacted metadata and compact evidence.

## Risks / Trade-offs

- [ACP implementations differ or evolve] → Pin supported ranges, negotiate capabilities, fixture real vendor shapes, and fail closed on required incompatibilities.
- [Current Copilot installation lacks ACP/JSONL] → Preserve the legacy adapter, document the minimum structured version after probing, and let capability validation prevent accidental reliance on durability it cannot provide.
- [ACP SDK beta/API churn enters core packages] → Isolate it in the bridge package behind SWF-owned types and Promise boundaries.
- [Permission translation grants excessive access] → Default deny, map only explicit resolved policy, audit every automatic response, and test path/tool boundaries.
- [A persistent blocked permission leaks processes] → Keep the invocation in an Effect scope with durable ownership, cancellation controls, timeout policy, and restart adoption.
- [Usage fields are incomplete or aggregate] → Preserve `exact`, `estimated`, and `unknown` provenance and never convert missing usage to zero.
- [JSON fallback semantics differ from ACP] → Give each transport a distinct codec/version and capability descriptor; do not mix records within one invocation.
- [Two harnesses substantially expand the test matrix] → Share ACP contract tests and keep vendor-specific fixtures focused on deltas.

## Migration Plan

1. Add capability probing and the ACP bridge transport without changing existing adapter defaults.
2. Add OpenCode schemas, requirements, registration, diagnostics, and fixture-backed JSON/ACP codecs behind optional selection.
3. Enable structured Copilot only for versions that pass the supported protocol probe; retain transcript fallback for older versions.
4. Extend normalized rendering, recovery, inspection, documentation, and simulated E2E coverage.
5. Run opt-in live smoke tests against installed/authenticated versions and record the validated minimum-version matrix.
6. Roll back by disabling ACP/JSON transport selection while retaining existing Copilot transcript behavior and leaving OpenCode unselected; retained protocol files remain readable by their recorded codec versions.

## Open Questions

- Which Copilot CLI release should become the minimum version for ACP support once a compatible binary is available for fixture and live validation?
- Does the chosen ACP SDK expose all cancellation, permission, and session-load semantics needed by both implementations, or should SWF keep a minimal internal client?
- Does OpenCode ACP expose invocation-attributable usage in the supported range, or should its usage initially remain unknown despite aggregate `stats` support?
- Should projects be able to disable ACP globally for troubleshooting, or is per-harness transport preference sufficient?
