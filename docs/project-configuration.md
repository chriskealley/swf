# Project configuration

Run `swf init --trust` inside a Git worktree to create project-owned defaults. The command does not overwrite an existing `.swf/` directory.

```text
.swf/
├── config.yaml
├── workflows/default.yaml
├── profiles/{planner,builder,reviewer,verifier,releaser}.yaml
├── guidelines/{planning,building,reviewing,verifying,releasing}.md
├── policies/{manual,autonomous,security-sensitive}.yaml
├── activities/{designing,testing,documenting,writing}.yaml
└── skills/{explore,new,run,next,phase,status,approve,artifacts}.md

.swf-state/  # ignored operational data
```

The default workflow is ordered Planning, Building, Reviewing, Verifying, and Releasing. Projects own every generated file and can extend or replace it; upgrades never silently restore defaults.

## Resolution order

SWF resolves settings from lowest to highest precedence:

1. built-in
2. user
3. project
4. workflow
5. phase
6. run-time

Arrays replace lower-precedence arrays. Nested objects merge recursively. The resolver records the winning source and every overridden source per leaf path, allowing callers to explain a value such as `gate.mode`.

## Validation

Before execution, SWF parses the selected workflow and project configuration, validates its versioned schemas, verifies profile and guideline references, and verifies profile capabilities requested by a phase. Invalid references stop before Herdr resources are created.

## Model tiers

New profiles use the policy labels `reasoning`, `coding`, and `fast`. These are project semantics, not universal rankings across providers. Bind each label to an installed harness model in `.swf/models.yaml`; SWF never guesses a provider model or silently falls back to a harness default. Use `swf model routes` to see unresolved paths and `swf model map <tier> <harness> <model>` to preview a binding before applying it.

Direct `model` values on an existing profile remain supported and win over that profile's tier. Missing mappings are reported with their exact configuration path before a workflow starts.

## Budgets and sensitive data

Optional `budgets` in `.swf/config.yaml` sets invocation, phase, named-phase, run, and project `maxCostUsd` or `maxTokens` ceilings. Budget evaluation fails closed on unknown telemetry unless `strictUnknown: false` is explicitly selected. Policy `budgetUsd` and `budgetTokens` act as phase-level fallbacks. See [operations.md](./operations.md) for precedence and diagnostics.

Do not commit credentials or secret values to `.swf/`. Configure runtime redaction and inject credentials through explicit local authentication or the process environment.

## Pull-request delivery

The default workflow explicitly selects `delivery.mode: pull-request` and `mergeMethod: merge`. Before expensive execution, the GitHub adapter verifies the configured remote and target branch, GitHub URL, network, `gh` authentication, branch push, pull-request creation, and any required merge or auto-merge permissions.

Manual policy opens or updates a pull request and waits for a human merge. Automatic policy requires recorded delegated authorization before requesting auto-merge. Projects may select `squash`, `rebase`, or `repository-default` merge behavior. `local-branch` bypasses GitHub checks only when explicitly configured. `direct-merge` additionally requires `allowDirectMerge: true` in the resolved policy.

Delivery failures use the policy's `deliveryFailureAction`, which is one of `remediate`, `escalate`, or `fail`. Execution status remains distinct from delivery status, so a completed run can continue to report `awaiting-merge` while the service monitors hosted checks and reviews.
