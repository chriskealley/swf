# Implementation Verification Report

- Change: `build-agentic-software-factory`
- Initial audit: 2026-08-09
- Remediation completed: 2026-08-09
- Result: **implemented and verification-complete**
- OpenSpec progress: **160/160 tasks complete**

## Audit and remediation

The initial traceability audit found that core scheduler, evidence, checks, checkpoint, and exploration components existed but were not connected to the persistent service and operator clients. Those tasks were reopened and implemented through a service-owned vertical slice rather than being accepted based on isolated helper tests.

The remediated production path now supports:

1. authenticated project registration and change/run creation from `swf new` or `swf run`;
2. explicit exploration creation, inspection, questions, retention, resume, cancellation, discard, show/list, and promotion;
3. durable Planning input from a description or explicitly selected exploration;
4. preflight configuration, adapter capability, delivery, policy, and budget validation;
5. one owned branch, Git worktree, Herdr workspace, and recorded runtime per run;
6. service-owned scheduling of agent, command, OpenSpec, human, and sequential work;
7. child invocation metadata and service-side recursive-orchestration rejection;
8. bounded progression through `new`, `run`, `next`, and named phase execution;
9. phase eligibility explanations, explicit rerun preview/authorization/invalidation, and authorized skip;
10. deterministic command/OpenSpec evidence, agent review checks, manual check refresh, gates, typed approvals, request-changes remediation, delegated auto-approval, and risk overrides;
11. same-context agent handoff requests with validated deterministic fallback;
12. phase commits or logical checkpoints, real Git rollback, artifact invalidation, and append-only rollback history;
13. compact portable dossier generation, including exploration foundation, evidence manifest, approvals, handoffs, checkpoints, delivery references, and final report;
14. manual or authorized autonomous pull-request delivery and monitoring;
15. startup reconciliation of recorded Herdr resources; and
16. CLI, Pi, dashboard, and authenticated API access without client-side state mutation.

## Acceptance coverage

The acceptance suite now invokes the real CLI through an authenticated loopback HTTP service in a disposable Git repository. It verifies:

- read-only exploration and explicit promotion;
- `swf new` Planning execution and stop behavior;
- a simulated agent followed by command work in the shared run worktree;
- deterministic checks and OpenSpec validation;
- checkpoint creation;
- `swf next` single-phase progression;
- create-if-absent and automatic `swf run` progression;
- completed-phase rejection and explicit rerun authorization/invalidation;
- individual check refresh;
- service-side child orchestration rejection;
- real Git rollback to a recorded checkpoint; and
- portable dossier creation.

## Final verification

Passed after remediation:

- `pnpm build`
- `pnpm check`
- `pnpm test` — 77 unit and 31 integration tests
- `pnpm test:e2e` — 4 passed, 1 explicitly opt-in live harness smoke test skipped
- `openspec validate build-agentic-software-factory`
- `git diff --check`

OpenSpec reports `all_done` with 160/160 tasks complete.

## Environment observations

The installed required versions satisfy the declared baseline. GitHub CLI and Codex were authenticated during the audit. Claude Code was installed but unauthenticated; Claude is optional unless selected by a workflow. Live harness execution remains intentionally gated by `SWF_LIVE_HARNESS_SMOKE=1` and is not treated as having run when that opt-in is absent.
