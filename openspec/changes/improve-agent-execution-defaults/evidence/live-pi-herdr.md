# Live Pi/Herdr execution evidence

Date: 2026-08-13

## Scope

The live check used two owned Herdr panes in the repository worktree. Pi was
started without tools, sessions, project context files, or project trust, so
the check could confirm concrete model selection without mutating project
files.

## Concrete model routes

- Tier `reasoning` launched Pi with `openai-codex/gpt-5.6-luna` and returned
  `SWF_LIVE_ROUTE_OK tier=reasoning model=openai-codex/gpt-5.6-luna`.
- Tier `fast` launched Pi with `openai-codex/gpt-5.4-mini` and returned
  `SWF_LIVE_ROUTE_OK tier=fast model=openai-codex/gpt-5.4-mini`.

Herdr reported both owned Pi panes as `idle` after completion. The first route
used 458 input and 28 output tokens; the second used 456 input and 55 output
tokens. Neither invocation called tools.

## Deterministic verification and agent-free Releasing

The repository validation immediately before this live check recorded:

- 97 unit tests passed.
- 34 service integration tests passed.
- 7 E2E tests passed and one explicitly opt-in live smoke remained skipped.
- TypeScript, ESLint, Prettier, strict OpenSpec validation, and Git whitespace
  verification passed.

`e2e/execution-defaults.test.ts` executes Planning, Building, Reviewing,
Verifying, and Releasing in order. It proves exact tier-to-model selection for
the four agent phases and asserts that Releasing has no work unit, no model
route, and no harness invocation. Release acceptance also proves deterministic
approval, delivery, dossier persistence, failure preservation, and owned
cleanup behavior.

