# SWF Architecture

## Workspace boundaries

| Module                           | Responsibility                                                                          | Must not own                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/core`                  | Versioned contracts, domain types, validation, prerequisite diagnostics, setup planning | HTTP, terminal UI, persistent scheduler processes    |
| `apps/service`                   | Nitro local API, event streaming, scheduler lifecycle, service authentication           | Client rendering or harness-specific workflow policy |
| `apps/cli`                       | Citty commands, JSON output, interactive confirmation, service client                   | Durable run-state mutation outside the service       |
| `apps/dashboard`                 | Vite/Vue global project and run views                                                   | Workflow scheduling or direct state-file mutation    |
| `extensions/pi`                  | Pi commands, tools, widgets, and service client                                         | Scheduler lifetime or durable run-state ownership    |
| `packages/integrations` (future) | Herdr, Git, GitHub, and harness adapters                                                | Domain transition policy                             |
| `packages/persistence` (future)  | JSONL event store, snapshots, locks, artifacts                                          | Client/UI and external process control               |

The core is intentionally framework-independent. The service is the only process permitted to schedule or mutate active runs. The CLI, dashboard, Pi extension, and generated harness skills are clients of the service.

## Dependency direction

```text
clients (CLI / Pi / dashboard)
              ↓
           service
          ↙       ↘
persistence       integrations
          ↘       ↙
             core
```

No core module may import a client framework, Nitro, Vue, Pi, Herdr, or GitHub SDK. Integration and persistence contracts are defined by core and implemented outward.

## Runtime layout

```text
project/.swf/        committed configuration and operator skills
project/.swf-state/  ignored events, snapshots, logs, and artifacts
openspec/changes/    planning and portable evidence dossier
~/.config/swf/       user-scoped service registry and endpoint metadata
```

## Tooling

- **Nitro**: local HTTP service and Server-Sent Events
- **Vite + Vue**: dashboard
- **Zod**: ergonomic TypeScript-facing validation
- **Ajv**: JSON Schema validation at persisted/interoperability boundaries
- **Citty**: CLI command definitions
- **nypm**: setup package-manager integration
- **Consola**: structured service and CLI logging
- **destr**: safe configuration parsing
- **Vitest**: unit, integration, and e2e test runner
- **ESLint + Prettier + TypeScript**: static analysis and formatting
