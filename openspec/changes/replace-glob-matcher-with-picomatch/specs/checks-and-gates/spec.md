## MODIFIED Requirements

### Requirement: Risk and fail-closed overrides
The system SHALL allow policy to require manual intervention for configured risk conditions regardless of general autonomous mode and SHALL fail closed when required authorization is missing or indeterminate.

Sensitive path rules SHALL be evaluated with standard glob semantics against repository-relative paths using forward slashes. A `**` segment SHALL match zero or more path segments, including at the start or end of a pattern; a single `*` SHALL match within one path segment only. Matching SHALL include paths whose segments begin with a dot, so that configuration directories such as `.github/` are covered. When a pattern cannot be evaluated, the system SHALL treat the path as sensitive rather than skipping the rule.

#### Scenario: Sensitive path changed
- **WHEN** autonomous mode is active but the diff matches a configured sensitive path rule
- **THEN** the gate waits for manual approval and explains the overriding risk rule
- **AND** the recorded reason names both the matched path and the rule that matched it

#### Scenario: Nested path under a prefix rule
- **WHEN** a sensitive path rule is `infra/**` and the diff changes `infra/aws/prod/main.tf`
- **THEN** the rule matches and the gate waits for manual approval

#### Scenario: Dotted configuration directory
- **WHEN** a sensitive path rule is `.github/**` and the diff changes `.github/workflows/ci.yml`
- **THEN** the rule matches and the gate waits for manual approval

#### Scenario: Leading wildcard at any depth
- **WHEN** a sensitive path rule is `**/security/**` and the diff changes `app/api/security/token.ts`
- **THEN** the rule matches and the gate waits for manual approval

#### Scenario: Leading wildcard matching zero segments
- **WHEN** a sensitive path rule is `**/security/**` and the diff changes `security/token.ts` at the repository root
- **THEN** the rule matches and the gate waits for manual approval

#### Scenario: Single wildcard does not span segments
- **WHEN** a sensitive path rule is `infra/*` and the diff changes `infra/aws/prod/main.tf`
- **THEN** the rule does not match on that rule alone and no sensitive-path reason is recorded for it

#### Scenario: Unevaluable pattern fails closed
- **WHEN** a configured sensitive path rule is empty, or has unbalanced `[]`, `{}`, or `()` delimiters
- **THEN** the system treats the rule as matching every changed path
- **AND** records a sensitive-path risk reason and requires manual approval rather than silently degrading the rule to a literal that never matches

#### Scenario: Well-formed delimiters still evaluate normally
- **WHEN** a sensitive path rule uses balanced glob syntax such as `infra/*.{tf,tfvars}` or `src/[a-z][0-9].ts`
- **THEN** the rule is evaluated as a glob and matches only paths satisfying it

#### Scenario: Required approver is unavailable
- **WHEN** a non-delegable human approval is required and no authorized operator responds
- **THEN** the system remains blocked or times out according to policy and does not advance automatically
