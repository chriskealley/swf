## ADDED Requirements

### Requirement: ACP initialization and capability negotiation
SWF SHALL initialize an ACP harness through a versioned client handshake, record the negotiated protocol and harness capabilities, and validate the selected phase requirements before submitting a work prompt.

#### Scenario: Compatible ACP server starts
- **WHEN** a supported Copilot or OpenCode ACP server completes initialization and advertises compatible session capabilities
- **THEN** SWF records the negotiated protocol descriptor and proceeds with the owned invocation

#### Scenario: Required ACP capability is absent
- **WHEN** a phase requires blocked-input response or session loading and the initialized ACP server does not advertise the corresponding capability
- **THEN** SWF fails validation before agent work starts and reports the missing capability and available transport alternatives

### Requirement: Correlated ACP session lifecycle
SWF SHALL create or load an ACP session, correlate prompts and responses by stable request and session identity, retain session updates in source order, and preserve the native session identifier for follow-up work.

#### Scenario: New ACP session executes
- **WHEN** SWF creates a session and submits a prompt
- **THEN** every resulting session update and terminal prompt response is correlated to the owned invocation and native session

#### Scenario: Existing ACP session resumes
- **WHEN** follow-up work references a retained session and the harness supports session loading
- **THEN** SWF loads that session before submitting the follow-up and records whether the original session or a documented fork was used

### Requirement: ACP permission mediation
SWF SHALL mediate ACP permission requests through resolved SWF tool and approval policy, automatically answer only choices already authorized by policy, and normalize requests needing operator choice as durable blocked input.

#### Scenario: Policy authorizes a tool request
- **WHEN** an ACP tool permission request is within the resolved automatic approval policy
- **THEN** SWF returns the authorized choice and records a redacted audit event without blocking the phase

#### Scenario: Operator choice is required
- **WHEN** no permission choice is authorized automatically and the harness supports a response
- **THEN** SWF keeps the invocation supervised, emits blocked input with bounded choices, and sends the selected response through the correlated ACP request

### Requirement: ACP cancellation and terminal settlement
SWF SHALL send protocol cancellation when supported, apply scoped process termination after a bounded grace period, and treat only a correlated terminal prompt response or documented terminal failure as settled invocation evidence.

#### Scenario: Prompt completes normally
- **WHEN** the ACP server returns a terminal prompt response with a supported stop reason after session updates
- **THEN** SWF emits completion and settlement exactly once and closes the owned protocol process safely

#### Scenario: Cancellation does not settle promptly
- **WHEN** cancellation is requested but the ACP server does not produce terminal evidence within the grace period
- **THEN** SWF interrupts the owned process tree, records cancellation degradation, and does not classify the invocation as successful

### Requirement: ACP framing and compatibility safety
ACP stdin and stdout SHALL be treated as protocol-only newline-delimited JSON channels with incremental framing, bounded partial-record buffering, schema validation, and required-versus-optional method handling.

#### Scenario: ACP frame arrives in chunks
- **WHEN** one JSON protocol record spans multiple process output chunks
- **THEN** SWF buffers it until its framing delimiter arrives and parses it exactly once

#### Scenario: Unknown required ACP response appears
- **WHEN** a response needed for session or terminal correctness has an unsupported shape
- **THEN** SWF retains bounded diagnostics and fails closed rather than inferring progress or settlement

### Requirement: ACP restart adoption
An ACP bridge and its child process SHALL be recorded as owned invocation resources, continue private capture independently of the service, and support service adoption from durable metadata and cursors.

#### Scenario: Service restarts during ACP work
- **WHEN** the SWF service restarts while the owned bridge and ACP server remain active
- **THEN** the service adopts the invocation, resumes normalized consumption from the durable cursor, and does not duplicate prior milestones

