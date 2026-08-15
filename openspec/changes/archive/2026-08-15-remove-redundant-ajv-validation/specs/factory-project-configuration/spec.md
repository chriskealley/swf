## ADDED Requirements

### Requirement: Single authoritative document validator
The system SHALL validate configuration and state documents against exactly one authoritative schema definition at runtime. Zod document schemas SHALL be that authority. Any JSON Schema the system publishes SHALL be derived from those Zod schemas and SHALL NOT be used as a second runtime validation path.

#### Scenario: Runtime document validation
- **WHEN** the system validates a workflow, policy, guideline, profile, run, event, or other versioned document at runtime
- **THEN** validation is performed by the document's Zod schema
- **AND** no additional JSON Schema validator is invoked to accept or reject the same document

#### Scenario: Derived JSON Schema export
- **WHEN** the system exposes JSON Schemas for external consumers
- **THEN** each schema is generated from its corresponding Zod document schema
- **AND** the export is documented as a derived, non-authoritative representation that may omit constraints Zod expresses but JSON Schema cannot

#### Scenario: Generated schemas remain well-formed
- **WHEN** the published JSON Schemas are built
- **THEN** each generated schema is a valid draft-2020-12 document that a standards-compliant validator can compile
- **AND** a failure to compile any generated schema fails the build or test suite

#### Scenario: Rejecting an invalid document
- **WHEN** a document fails its Zod schema
- **THEN** validation fails with the offending field path and the reason
- **AND** the failure is reported before any execution resource is created
