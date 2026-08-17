# Operations, security, retention, and recovery

## Service security boundary

The persistent service is the sole scheduler and active-state writer. It accepts only loopback HTTP endpoints (`localhost`, `127.0.0.1`, or `::1`) and rejects startup when configured with a non-loopback endpoint. Every API route except health requires the bearer credential stored in the private user service metadata. Browser origins must also be loopback HTTP origins.

Register a project only after explicitly trusting it:

```sh
swf init --trust
```

Trust is stored in the user's SWF configuration directory. Registration fails closed for an untrusted root. The user service directory and project `.swf-state/` directories are mode `0700`; credentials, locks, state documents, raw output, exports, and audit logs are mode `0600`. SWF never cleans a Herdr or Git resource unless its identifier appears in the run's ownership record.

Mutating service operations append redacted records to `~/.config/swf/audit.jsonl`. Run mutations additionally remain in each run's append-only `events.jsonl`.

## Redaction

SWF redacts recognized bearer credentials, provider keys, GitHub tokens, password/secret assignments, sensitive object fields, configured literal values, and configured regular expressions before writing events, raw logs, artifacts, service events, audit records, or API output. Programmatic embedders can supply `RedactionOptions.sensitiveValues` and `RedactionOptions.patterns` to the service, event store, and artifact store. Do not place secret literals in committed `.swf/` configuration; pass them through the process environment or another local secret provider.

Redaction is defense in depth, not a reason to prompt agents with unnecessary credentials. Rotate a credential if it may have appeared before redaction was configured.

## Raw-output retention

Raw invocation output is retained by default. Preview pruning by age, one run, or a project storage ceiling in the dashboard, or use the authenticated pruning API. A confirmation ID expires after five minutes and binds the exact candidate list; deletion cannot be requested without a fresh preview.

Preview and confirm from the CLI when preferred:

```sh
swf prune --project <project-id> --age 30
swf prune --project <project-id> --run <run-id>
swf prune --project <project-id> --budget 1073741824
swf prune --project <project-id> --confirm <confirmation-id>
```

Confirmed pruning removes only eligible native protocol, control, and legacy raw-output files below a run's `raw/` directory. It preserves normalized invocation events, cursor-safe terminal state, invocation metadata, token/cost records, summaries, artifact manifests, approvals, checkpoints, delivery records, and the committed OpenSpec dossier. Metadata records when native protocol output became unavailable; `retention.jsonl` and the service audit log record every removed reference.

Export a run before pruning when full transcripts must be archived:

```sh
swf transfer export --project <project-id> --run <run-id> ./run.swf-export.json
```

## Harness output and diagnostics

Generated projects use `harnessPresentation.level: normal`, which shows compact readiness, work, attention, failure, and settlement milestones. Use `quiet` for unattended panes and `verbose` for bounded redacted message and tool detail. Reserve `protocol` for audited diagnosis: it displays redacted machine records and can still contain sensitive operational context. A presentation change applies to newly launched invocations.

Routine investigation starts with `swf status <change>` and the phase/invocation views. Invocation diagnostics expose the effective presentation level, codec version, capture health, durable native and normalized cursors, consumed cursor, and renderer degradation without returning native payloads. Use authenticated `native-output` inspection only when normalized diagnostics are insufficient; always request a bounded cursor, record limit, and byte limit.

After service restart, SWF re-adopts owned surviving bridge processes and resumes after the durable service cursor. Already-consumed milestones are not replayed. If native output was pruned, normalized terminal state and diagnostics remain available. Missing or incompatible required normalized capture fails closed; retain the invocation directory and run export before attempting manual repair.

## Cost and token budgets

Budgets support `maxCostUsd`, `maxTokens`, and `strictUnknown` at invocation, phase, named-phase, run, project, and service scopes. Project scopes live under `budgets` in `.swf/config.yaml`; policy `budgetUsd` and `budgetTokens` provide a phase fallback. Service budgets are supplied by the service host. The most restrictive applicable scope wins.

Exact and estimated spend count toward limits. Unknown telemetry is never treated as zero. With the default `strictUnknown: true`, an applicable cost or token budget fails closed when required telemetry is unknown. Inspect resolved decisions with:

```sh
swf budget --project <project-id> --run <run-id>
```

## Stuck work and orphan reconciliation

Inspect operational health without changing state:

```sh
swf operations --project <project-id>
swf reconcile --project <project-id>
```

The report identifies invocations that remain running or blocked beyond the configured threshold, terminal runs that still own recorded resources, and unreadable runs. Apply reconciliation explicitly:

```sh
swf reconcile --project <project-id> --apply
```

Applied reconciliation blocks a running run whose invocation is stuck and attempts cleanup only for resources listed in terminal-run ownership metadata. Failures remain in the report and audit log for manual remediation.

## State migrations

Persisted state formats are versioned. Always preview a migration first:

```sh
swf migrate --project <project-id>
```

Apply only after reviewing the ordered migration plan:

```sh
swf migrate --project <project-id> --apply
```

Before changing files, SWF writes a checksummed private backup under `.swf-state/backups/`. Migrations advance one registered version at a time and update `state-version.json`. A failed migration automatically restores its backup. An operator can also roll back explicitly:

```sh
swf migrate --project <project-id> --rollback <backup-id>
```

Committed `.swf/` project configuration is project-owned and is never silently migrated or overwritten with factory defaults.

Check discovery is read-only. `swf check discover` proposes exact commands, working directories, phases, timeouts, and required status; `swf check adopt --ids ...` previews a selection and `--apply` writes it only after explicit operator confirmation. Default updates follow the same rule: `swf defaults` inspects the three-way diff, while `swf defaults --apply --paths ...` adopts selected non-conflicting files with a private recoverable backup.

Releasing is deterministic and agent-free in newly generated workflows. It performs a source/target/remote/dirty-state/policy preflight, records a release-specific gate summary, and preserves owned resources on delivery failure. OpenSpec archive is never inferred from Releasing; use the explicit archive command after successful delivery.

## Complete run export and import

A run export includes every file below `.swf-state/runs/<run-id>/`, including metadata, events, snapshots, runtime ownership, artifacts, raw output, retention records, and delivery history. Each file and the manifest are SHA-256 verified. Import rejects path traversal, corruption, duplicate run IDs, and conflicting OpenSpec bindings.

```sh
swf transfer export --project <source-project-id> --run <run-id> ./run.swf-export.json
swf transfer import --project <target-project-id> ./run.swf-export.json
```

Exports can contain sensitive operational history. Store and transfer them as private files even though SWF applies configured redaction before normal persistence.

## Crash and dependency recovery

After an unclean stop, restart the service and inspect `swf operations`. Event-log replay ignores an interrupted trailing partial line; the next append repairs it. Snapshots are rebuildable. Full-disk and permission failures abort writes without claiming a transition succeeded. Network and GitHub failures remain delivery failures separate from completed execution. Adapter diagnostics report changed or incompatible harness availability before launch.

Use normal shutdown whenever possible:

```sh
swf service stop
swf service stop --force  # interrupts only SWF-owned execution
```

Run exports and the committed OpenSpec evidence dossier are complementary backups: the export preserves complete local operational history, while the dossier preserves compact conclusions in Git.

## Dashboard

Start the service and dashboard, then enter the loopback service endpoint and bearer credential from the private service metadata. Credentials remain in browser memory and are sent only to loopback HTTP endpoints. The dashboard provides project/run timelines, retained output, artifact and delivery inspection, cost provenance, adapter capabilities, safe run controls, and preview-plus-confirmation retention controls.

## Operator guidance and progress

Use `swf status <change>` as the primary recovery and orientation command. It reports the actual stopping phase, typed attention, retained evidence, and service-authorized next actions. Workflow commands stream bounded durable milestones; stream loss does not change execution and the final projection remains authoritative. Human progress goes to stderr, while `--json` emits one versioned document to stdout and never prompts.

For unattended operation, pass `--no-interactive` explicitly. TTY approval menus require `--interactive`, default to exiting without mutation, preserve actor/reason fields, and ask for confirmation before decisions.

## Autonomous-policy implications

Autonomous execution and automatic merge are separate authorizations. Automatic gates require recorded delegated human authorization, and automatic pull-request merging requires delivery authorization and repository support. Sensitive-path, secret-finding, destructive-operation, elevated-risk, and budget rules can force manual intervention. Direct merge is disabled unless both the workflow selects it and resolved policy has `allowDirectMerge: true`.

### Sensitive-path rule matching

Sensitive-path rules are globs evaluated against repository-relative, forward-slash paths. `**` matches zero or more path segments, a single `*` matches within one segment, and segments beginning with a dot are matched, so `.github/**` covers `.github/workflows/ci.yml`. A rule that is empty or has unbalanced `[]`, `{}`, or `()` delimiters cannot be evaluated and is treated as matching every changed path, forcing manual approval rather than silently becoming a rule that never fires. When a rule matches, the recorded reason names both the matched path and the rule.

**Behavior change:** sensitive-path rules previously did not match as documented — `**` could not span path separators, so rules such as `.github/**`, `infra/**`, and `**/security/**` failed to match nested paths and the gate did not fire. Projects running autonomously with `sensitive-path` in `policy.riskOverrides` will now correctly stop for manual approval on changes that previously auto-approved.

## Managed user service

SWF can install a user-scoped background service on macOS (a launchd agent) and Linux (a systemd user unit). Installing the package never registers, enables, or starts one — every step is previewed and separately confirmed.

```
swf service install                    # preview only; changes nothing
swf service install --apply --yes      # write the definition
swf service install --apply --yes --at-login   # also start at login
swf service check                      # diagnose the installed definition
swf service uninstall                  # preview removal
swf service uninstall --apply --yes    # remove the definition
```

`swf service install` prints the destination, executable, arguments, working directory, log paths, environment, and the exact enable command before anything is written. Applying writes the definition with `0600` permissions and then **stops**: enabling and starting are left to you, so a package installation can never launch a background process.

| Platform | Definition                                     |
| -------- | ---------------------------------------------- |
| macOS    | `~/Library/LaunchAgents/dev.swf.service.plist` |
| Linux    | `~/.config/systemd/user/swf.service`           |

Both definitions pin the service to `127.0.0.1`, set an explicit service home, and disable automatic restart. Neither starts at login unless `--at-login` is passed.

### Diagnosing a stale definition

Node version managers relocate binaries and package upgrades move product paths, so a definition can end up referencing an executable that no longer exists — failing at login with no explanation. `swf service check` reports the specific stale path:

```
stale-package: configured service entry is missing: /usr/local/lib/node_modules/@chriskealley/swf/service/server/index.mjs
  The product was moved or reinstalled. Run swf service install --repair.
```

`swf service install --repair` previews a replacement definition; `--repair --apply --yes` rewrites it.

SWF only ever modifies definitions it owns. A file at the same path that SWF did not write is reported as `not-owned` and is never edited or removed.

### Uninstall preserves state

Removing the managed service removes only the definition. The service home, credentials, registries, logs, audit history, and every project's `.swf/` and `.swf-state/` are preserved. Service uninstall is not state uninstall — see the destructive cleanup commands for that.

### Where managed services are unsupported

On other platforms, run the service directly. `swf service start` detaches it and writes private rotating logs, `swf service stop` ends it, and `swf service logs` shows a bounded redacted tail.
