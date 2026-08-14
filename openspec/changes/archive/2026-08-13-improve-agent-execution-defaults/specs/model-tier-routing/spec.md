## ADDED Requirements

### Requirement: Provider-neutral model tiers
SWF SHALL support named provider-neutral model tiers that phase profiles can select independently of concrete harness model identifiers. The default phase routes SHALL select `reasoning` for Planning, `coding` for Building, `reasoning` for Reviewing, `fast` for Verifying, and no model for deterministic Releasing.

#### Scenario: Default phase tier selection
- **WHEN** a newly generated default workflow resolves its phase profiles
- **THEN** each agent phase selects its declared default tier and Releasing declares no agent model requirement

#### Scenario: Project changes a phase tier
- **WHEN** a project changes the Verifying profile from `fast` to `reasoning`
- **THEN** future Verifying attempts deterministically resolve the concrete model mapped to the `reasoning` tier

### Requirement: Concrete harness mappings
Each tier used by a phase SHALL resolve through configuration to a concrete model supported by the selected harness. Tier mappings MAY be defined at user or project scope, and configuration diagnostics SHALL identify unresolved mappings before Herdr resources are created.

#### Scenario: Pi tier resolves
- **WHEN** the Verifying profile selects `fast` and the effective Pi mapping binds `fast` to a concrete Pi model identifier
- **THEN** the invocation launches with that exact model identifier and records tier, mapping source, and concrete model

#### Scenario: Tier mapping is absent
- **WHEN** a selected tier has no effective mapping for the selected harness and harness-default use is not explicitly enabled
- **THEN** the phase fails preflight with actionable model-configuration guidance before creating runtime resources

### Requirement: Deterministic static routing
Model routing SHALL be resolved from versioned configuration before a phase attempt starts and SHALL remain fixed for that attempt. SWF SHALL NOT dynamically switch models based on inferred complexity, cost, output quality, or a model's self-assessment.

#### Scenario: Verification check fails
- **WHEN** Verifying uses the `fast` tier and a deterministic check fails
- **THEN** SWF retains the configured `fast` route and follows declared failure or remediation policy rather than silently escalating to another tier

#### Scenario: Retry begins
- **WHEN** a retry is authorized without a configuration revision
- **THEN** the retry uses the same tier and concrete model resolution as the prior attempt

### Requirement: Explicit model override precedence
SWF SHALL support an explicit concrete model override at permitted configuration layers. The effective model resolution SHALL follow documented configuration precedence, and an explicit concrete model at the winning layer SHALL take precedence over that layer's tier selection.

#### Scenario: Runtime model override
- **WHEN** an authorized runtime request specifies a concrete model for one phase
- **THEN** that model is capability-validated, recorded as a runtime override, and used only within its authorized scope

#### Scenario: Project tier override
- **WHEN** no concrete model override exists and the project changes a profile's model tier
- **THEN** the project tier wins over built-in defaults and resolves through the effective harness mapping

### Requirement: Visible resolution provenance
Configuration inspection, phase explanation, run records, invocation records, evidence dossiers, and budget decisions SHALL identify the requested tier, concrete model, selected harness, winning configuration source, overridden sources, and any fallback used.

#### Scenario: Operator explains model choice
- **WHEN** an operator inspects the Building phase before execution
- **THEN** SWF reports that Building selected `coding`, the concrete model mapping, and where both selections were configured

#### Scenario: Dossier records model use
- **WHEN** a run completes
- **THEN** its dossier records the tier and concrete model used by each agent invocation without exposing credentials

### Requirement: Explicit fallback only
SWF SHALL NOT silently use a harness default or substitute another tier when model resolution or availability fails. Fallback to a harness default or ordered concrete alternatives SHALL occur only when explicitly configured and SHALL be reported before and after execution.

#### Scenario: Configured fallback is used
- **WHEN** the primary concrete model is unavailable and an explicitly declared compatible fallback is available
- **THEN** SWF records the fallback decision and uses the declared fallback

#### Scenario: No fallback is configured
- **WHEN** the resolved concrete model is unavailable and no fallback is declared
- **THEN** execution stops with a dependency attention item rather than launching another model

### Requirement: Capability and budget preflight
The resolved model and harness SHALL satisfy required phase capabilities and applicable fail-closed budgets before invocation. Unknown model usage characteristics SHALL not be treated as zero cost.

#### Scenario: Model lacks a required capability
- **WHEN** the resolved model or adapter cannot satisfy a phase's required structured-event or tool capability
- **THEN** preflight rejects the route and identifies the unsatisfied capability

#### Scenario: Budget cannot admit the route
- **WHEN** an applicable budget cannot safely admit a statically selected route because required usage is unknown
- **THEN** execution follows configured strict-unknown policy and does not silently select a cheaper model
