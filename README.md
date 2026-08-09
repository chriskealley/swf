# SWF — Agentic Software Factory

SWF turns OpenSpec changes into durable, auditable agent workflows. A persistent local service coordinates phase execution through Herdr-managed harnesses, stores operational history outside Git, enforces checks and approval gates, and delivers completed changes through pull requests.

SWF includes:

- a persistent authenticated Nitro service;
- a Citty CLI and Pi extension;
- a Vue dashboard;
- Pi, Codex CLI, Claude Code, and GitHub Copilot CLI adapters;
- isolated Git branches and worktrees;
- deterministic evidence, checkpoints, rollback, and OpenSpec dossiers;
- cost budgets, retention controls, recovery, and run export/import.

> **Status:** This repository is currently a source-based, pre-release workspace. macOS and Linux are supported. Native Windows support is preview-only.

## Requirements

### Required

| Tool              | Minimum version | Purpose                                         |
| ----------------- | --------------: | ----------------------------------------------- |
| Node.js           |       `22.19.0` | SWF and TypeScript runtime                      |
| pnpm              |       `11.20.0` | Workspace package manager                       |
| Git               |        `2.30.0` | Branches, worktrees, checkpoints, and rollback  |
| Herdr             |         `0.7.4` | Harness process and terminal supervision        |
| Pi                |        `0.83.0` | Reference harness and SWF extension host        |
| OpenSpec          |         `1.6.0` | Change planning and validation                  |
| GitHub CLI (`gh`) |         `2.0.0` | GitHub authentication and pull-request delivery |

Interactive Pi and Herdr usage requires a modern UTF-8, ANSI-capable terminal. Ghostty is supported but not required.

### Optional harnesses

These are required only when selected by a workflow:

| Harness            | Minimum tested version |
| ------------------ | ---------------------: |
| Codex CLI          |              `0.146.0` |
| Claude Code        |              `2.1.222` |
| GitHub Copilot CLI |              `0.0.358` |

See [Harness adapter capabilities](docs/harness-adapters.md) for structured-output, resume, tool-policy, model, and usage limitations.

## Installation from source

Clone the repository and install its pinned workspace dependencies:

```sh
git clone <repository-url> swf
cd swf

corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install
pnpm build
```

Run non-mutating diagnostics:

```sh
pnpm swf doctor
```

Diagnostics check required tools, versions, PATH visibility, Git support, project permissions, Herdr integrations, selected harnesses, GitHub authentication, and terminal capabilities.

### Convenient source-checkout command

Commands below use `swf`. Until a published package is available, either prefix commands with `pnpm --dir /path/to/swf swf` or define a shell function:

```sh
export SWF_REPO="$HOME/src/swf"
swf() { pnpm --dir "$SWF_REPO" --silent swf "$@"; }
```

SWF never silently installs software or creates credentials. Preview supported remediation before applying it:

```sh
swf setup herdr
swf setup herdr-integration:pi
swf setup gh

# Apply only after reviewing the displayed source and command.
swf setup herdr-integration:pi --apply --yes
```

Authentication remains explicit:

```sh
gh auth login
```

## Project setup

Run initialization from a trusted Git worktree:

```sh
cd /path/to/project
swf init --cwd "$PWD" --trust
```

Initialization creates:

```text
.swf/        # committed, project-owned workflows, profiles, policies, and skills
.swf-state/  # ignored operational history, outputs, snapshots, and artifacts
```

It also adds `/.swf-state/` to the root `.gitignore`. Existing `.swf/` customizations are never silently overwritten.

The default workflow is:

```text
Planning → Building → Reviewing → Verifying → Releasing
```

## GitHub delivery setup

The default workflow uses pull-request delivery through the `origin` remote and targets `main`. Configure these explicitly when needed:

```sh
git remote add origin git@github.com:<owner>/<repository>.git
git remote -v
gh auth status
gh repo view
```

Before expensive execution, SWF checks network access, the target branch, authentication, push and pull-request permissions, and any merge permissions required by policy.

To work without GitHub delivery, explicitly select `local-branch` in the project workflow. SWF never invents a remote or silently changes delivery policy.

## Start the service

The service is the sole scheduler and active-state writer. It binds to loopback HTTP and continues running when CLI, Pi, or dashboard clients disconnect.

```sh
swf service start
swf service status
swf service diagnostic
```

The default endpoint is:

```text
http://127.0.0.1:34671
```

Service metadata and its private bearer credential are stored at:

```text
~/.config/swf/service.json
```

`SWF_SERVICE_HOME` or `SWF_CONFIG_HOME` can override that directory. Keep this file private.

Stop the service gracefully whenever possible:

```sh
swf service stop
swf service stop --force  # interrupts only SWF-owned execution
```

## Usage

Run `swf --help` or `swf <command> --help` for the authoritative CLI syntax.

### Workflow entry points

SWF's operator workflow is centered on:

- `swf explore` — durable read-only exploration;
- `swf new` — initialize work and execute only the first eligible phase;
- `swf run` — create or resume automatic progression;
- `swf next` — execute exactly one eligible phase;
- `swf phase` — inspect or control a named phase;
- `swf check` — inspect or refresh declared checks.

The current source CLI submits lifecycle operations using registered project and run IDs:

```sh
swf status --project <project-id> --run <run-id>
swf run --project <project-id> --run <run-id>
swf next --project <project-id> --run <run-id>
swf phase list --project <project-id> --run <run-id>
```

Project IDs are in `.swf/config.yaml`; run IDs are visible through the dashboard, Pi extension, service API, and run listings.

### Run control and approvals

```sh
swf pause --project <project-id> --run <run-id>
swf resume --project <project-id> --run <run-id>
swf cancel --project <project-id> --run <run-id>

swf approve \
  --project <project-id> \
  --run <run-id> \
  --phase <phase-id> \
  --gate <gate-id> \
  --actor <operator-id>
```

### Evidence, costs, and configuration

```sh
swf artifacts --project <project-id> --run <run-id>
swf log --project <project-id> --run <run-id>
swf cost --project <project-id> --run <run-id>
swf budget --project <project-id> --run <run-id>
swf config --project <project-id>
```

### Delivery

```sh
swf delivery status --project <project-id> --run <run-id>
swf delivery start --project <project-id> --run <run-id>
swf delivery refresh --project <project-id> --run <run-id>
```

Manual policy opens or updates a pull request and waits for human merge. Autonomous execution and automatic merge require separately recorded delegated authorization.

### Retention and recovery

Preview pruning before confirming it:

```sh
swf prune --project <project-id> --age 30
swf prune --project <project-id> --run <run-id>
swf prune --project <project-id> --budget 1073741824
swf prune --project <project-id> --confirm <confirmation-id>
```

Inspect and reconcile stuck or orphaned owned resources:

```sh
swf operations --project <project-id>
swf reconcile --project <project-id>
swf reconcile --project <project-id> --apply
```

Preview migrations before applying them:

```sh
swf migrate --project <project-id>
swf migrate --project <project-id> --apply
swf migrate --project <project-id> --rollback <backup-id>
```

Export or import complete operational run history:

```sh
swf transfer export \
  --project <project-id> \
  --run <run-id> \
  ./run.swf-export.json

swf transfer import \
  --project <project-id> \
  ./run.swf-export.json
```

## Dashboard

Start the dashboard development server from the SWF checkout:

```sh
pnpm dev:dashboard
```

Open the local URL printed by Vite, then enter the service endpoint and credential from the private service metadata. Dashboard credentials remain in memory and are sent only to loopback HTTP endpoints.

The dashboard provides project and run timelines, phase status, retained output, artifacts, delivery state, cost provenance, budget status, adapter capabilities, safe controls, and preview-plus-confirmation pruning.

## Development

```sh
pnpm build
pnpm check
pnpm test
pnpm test:e2e
```

Run the service or dashboard in development mode:

```sh
pnpm dev:service
pnpm dev:dashboard
```

Live harness smoke tests are opt-in:

```sh
SWF_LIVE_HARNESS_SMOKE=1 \
SWF_LIVE_HARNESS=codex \
pnpm test:e2e
```

## Security and storage

- `.swf/` is committed project configuration.
- `.swf-state/` is ignored operational state.
- The local API requires a bearer credential and accepts only loopback HTTP.
- Project execution requires explicit trust.
- Sensitive values are redacted before normal persistence and API responses.
- Unknown cost is reported as unknown, never zero.
- Cleanup targets only resources recorded as SWF-owned.
- Raw-output pruning preserves summaries, events, costs, approvals, checkpoints, manifests, and the OpenSpec evidence dossier.

## Documentation

- [Installation and prerequisites](docs/installation.md)
- [Project configuration](docs/project-configuration.md)
- [Architecture](docs/architecture.md)
- [Harness adapter capabilities](docs/harness-adapters.md)
- [Security, retention, recovery, migration, and transfer](docs/operations.md)
