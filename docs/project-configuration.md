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
