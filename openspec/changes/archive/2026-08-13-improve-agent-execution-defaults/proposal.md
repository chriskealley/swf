## Why

SWF currently generates vague one-line agent guidelines, leaves every profile's model unspecified, and assigns a general-purpose agent to every phase even when deterministic orchestration is safer. This makes execution quality, cost, phase responsibilities, verification rigor, and release behavior depend too heavily on whichever harness defaults happen to be active.

## What Changes

- Introduce provider-neutral model tiers and deterministic static routing from each phase profile to a configured concrete harness model.
- Preserve explicit concrete model overrides while making model-tier resolution, provenance, capability validation, and permitted fallback visible before execution.
- Replace generic phase prompts with structured phase contracts covering objectives, responsibilities, allowed scope, required outputs, completion criteria, and prohibited actions.
- Give Planning, Building, Reviewing, and Verifying distinct responsibilities; Reviewing remains responsible for code review, while Verifying audits OpenSpec task completion and deterministic evidence rather than repeating code review.
- Replace the default general-purpose Releasing agent with deterministic delivery orchestration that merges or delivers the run branch and performs configured cleanup only after required approval or recorded delegated automatic authorization.
- Add useful default completion and gate expectations so automatic progression cannot rely on narrative agent success alone.
- Discover plausible project checks during initialization or explicit configuration inspection, but require operator review before adopting or executing discovered commands.
- Add versioned default-template inspection, diff, and selective adoption for existing projects without silently overwriting committed `.swf/` configuration.

## Capabilities

### New Capabilities
- `model-tier-routing`: Provider-neutral model tiers, static phase routing, concrete harness mappings, precedence, provenance, capability validation, and explicit fallback behavior.
- `phase-agent-contracts`: Structured prompt construction and distinct Planning, Building, Reviewing, and Verifying responsibilities, outputs, limits, and completion contracts.
- `verification-release-defaults`: Verification of OpenSpec task completion and deterministic evidence, plus approval-aware deterministic branch delivery, merge, and cleanup behavior for Releasing.
- `default-template-lifecycle`: Safe project-check discovery and versioned inspection, diff, and selective adoption of improved SWF defaults.

### Modified Capabilities

None. The repository does not yet contain archived main capability specs for these behaviors.

## Impact

- Affects project, profile, workflow, and model configuration schemas and their precedence/provenance reporting.
- Affects generated `.swf/` profiles, guidelines, workflows, checks, and template metadata for newly initialized projects.
- Affects service prompt construction, phase execution, adapter validation, verification evidence, release/delivery orchestration, authorization checks, and cleanup ownership.
- Affects CLI and dashboard configuration diagnostics for model routes, discovered checks, and default-template differences.
- Requires migration-safe behavior for existing project-owned configuration; no existing `.swf/` file may be silently replaced.
- Does not weaken manual approval, delegated automatic authorization, fail-closed budgets, trusted-project boundaries, or service ownership of scheduling and state.
