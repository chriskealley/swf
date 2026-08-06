# Installation and prerequisites

## Supported platforms

SWF supports macOS and Linux. Native Windows is preview-only because Herdr's native Windows support is preview. The service and dashboard do not need an interactive terminal. Interactive Pi and Herdr use needs a UTF-8, ANSI-capable terminal.

Ghostty is supported but optional. iTerm2, WezTerm, Kitty, macOS Terminal, GNOME Terminal, and comparable terminals are also suitable.

## Required tools

| Tool              | Minimum                   | Purpose                               |
| ----------------- | ------------------------- | ------------------------------------- |
| Node.js           | 22.19.0                   | SWF, Pi, and TypeScript runtime       |
| Git               | 2.30.0                    | Worktrees, checkpoints, and rollback  |
| Herdr             | declared compatible range | Agent terminal/process execution      |
| Pi                | declared compatible range | Reference harness and SWF extension   |
| OpenSpec          | 1.6.0                     | Change planning artifacts             |
| GitHub CLI (`gh`) | 2.0.0                     | Authentication and GitHub PR delivery |

Codex CLI, Claude Code, and GitHub Copilot CLI are optional until a project workflow selects them.

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

A default pull-request workflow additionally requires a GitHub remote, branch push permission, pull-request creation permission, and merge or auto-merge permission required by its policy. A workflow explicitly configured for local-branch delivery does not require GitHub delivery access.
