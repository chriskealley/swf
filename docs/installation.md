# Installation and prerequisites

## Supported platforms

SWF supports macOS and Linux. Native Windows is preview-only because Herdr's native Windows support is preview. The service and dashboard do not need an interactive terminal. Interactive Pi and Herdr use needs a UTF-8, ANSI-capable terminal.

Ghostty is supported but optional. iTerm2, WezTerm, Kitty, macOS Terminal, GNOME Terminal, and comparable terminals are also suitable.

## Required tools

| Tool              | Minimum                   | Purpose                               |
| ----------------- | ------------------------- | ------------------------------------- |
| Node.js           | 24.0.0                    | SWF, Pi, and TypeScript runtime       |
| Git               | 2.30.0                    | Worktrees, checkpoints, and rollback  |
| Herdr             | declared compatible range | Agent terminal/process execution      |
| Pi                | declared compatible range | Reference harness and SWF extension   |
| OpenSpec          | 1.6.0                     | Change planning artifacts             |
| GitHub CLI (`gh`) | 2.0.0                     | Authentication and GitHub PR delivery |

Codex CLI, Claude Code, and GitHub Copilot CLI are optional until a project workflow selects them. Their verified structured-output, resume, model, permission, and usage capabilities are documented in [harness-adapters.md](./harness-adapters.md); selected adapters also require their matching Herdr status integration.

## Bootstrap

A Node-based CLI cannot install a missing Node runtime. Install a compatible Node release first, then install SWF through its published package or checkout. Run:

```sh
swf doctor
```

`swf doctor` is non-mutating. It reports platform, versions, PATH visibility, terminal suitability, Git worktree and remote state, GitHub authentication, Herdr integrations, and selected harness readiness.

## Explicit setup

Preview a remediation before changing the machine:

```sh
swf setup herdr
swf setup herdr-integration:pi
swf setup gh
```

Apply a displayed plan only after reviewing its source, version, destination, and command:

```sh
swf setup herdr-integration:pi --apply --yes
```

Setup never silently downloads a terminal emulator, invents a Git remote, or creates credentials. Authenticate GitHub explicitly when required:

```sh
gh auth login
```

A default pull-request workflow additionally requires a GitHub remote, branch push permission, pull-request creation permission, and merge or auto-merge permission required by its policy. Configure and verify the default remote explicitly:

```sh
git remote add origin git@github.com:<owner>/<repository>.git
git remote -v
gh repo view
gh auth status
```

SWF never invents or replaces a remote. A workflow explicitly configured for local-branch delivery does not require GitHub delivery access.

## Initialize and operate

```sh
swf init --trust
swf service start
swf service status
swf service diagnostic
```

Use `swf new`, `swf run`, or `swf explore` to begin work. The service continues after CLI, Pi, or dashboard clients disconnect. Use `swf service stop` for safe draining or `swf service stop --force` only when owned execution must be interrupted.

From an initialized project, routine inspection and decisions use the change name (`swf status <change>`, `swf approve <change>`, `swf next <change>`). The CLI resolves the project from cwd and the run from its durable change binding. Use explicit IDs only for automation, cross-project work, or displayed ambiguity alternatives.

The dashboard connects only to the loopback endpoint and credential published in the private service metadata. Adapter versions and capability limitations are in [harness-adapters.md](./harness-adapters.md). Security, autonomous-policy implications, pruning, budgets, reconciliation, migration, export/import, and crash recovery are covered in [operations.md](./operations.md).

# Installation and first-run configuration

After `swf init --trust`, inspect the generated `.swf/models.yaml` and bind the three policy tiers to models installed in the selected harness. SWF intentionally leaves those values unset because model identifiers and credentials are provider- and operator-specific.

Run `swf model routes` before the first workflow. Resolve every tier used by the workflow with `swf model map ...`; the command previews the exact configuration path and only `--apply` writes it.

Use `swf check discover` to review project checks before adopting them. Initialization and discovery do not install dependencies, execute scripts, or overwrite an existing project configuration.
