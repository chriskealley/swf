# Harness adapter capability notes

Investigated 2026-08-09 against the installed CLIs and current vendor documentation. SWF advertises only capabilities available through stable, non-interactive CLI interfaces; interactive-only metrics and experimental servers are not treated as adapter contracts.

| Adapter            | Observed version           | Structured output                               | Native resume                          | Model     | Tool policy                                                       | Usage/cost                                                    |
| ------------------ | -------------------------- | ----------------------------------------------- | -------------------------------------- | --------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Pi                 | compatible reference range | LF-delimited RPC events                         | No (`--no-session`)                    | Yes       | Include/exclude tools                                             | Tokens and cost when RPC reports them                         |
| Codex CLI          | `0.146.0`                  | `codex exec --json` JSONL                       | `codex exec resume <SESSION_ID>`       | `--model` | Sandbox and approval policy; no stable include/exclude tool flags | Exact token counts from `turn.completed`; cost unknown        |
| Claude Code        | `2.1.222`                  | `--print --output-format stream-json --verbose` | `--resume <SESSION_ID>` / `--continue` | `--model` | `--tools`, `--allowedTools`, `--disallowedTools`, permission mode | Token counts and client-estimated `total_cost_usd`            |
| GitHub Copilot CLI | `0.0.358`                  | No documented JSONL event stream in prompt mode | `--resume [sessionId]` / `--continue`  | `--model` | `--allow-tool`, `--deny-tool`, `--allow-all-tools`                | Interactive `/usage` only; programmatic usage remains unknown |

All adapters launch in an SWF-owned Herdr pane and run in the shared run worktree. Cancellation sends the Herdr interrupt only to the owned pane. Follow-up submission uses the harness's native resume command when a session identifier was observed and its documented “continue most recent” behavior otherwise.

## Codex CLI

SWF uses `codex exec --json` with the `workspace-write` sandbox and non-interactive approval policy. The JSONL stream includes `thread.started`, turn events, item events, errors, and `turn.completed.usage`. The `thread_id` is retained as the native session identifier. `--output-schema` is available for final structured results, but is not required for the general event adapter. Codex supports explicit model selection and native non-interactive resume. It does not expose stable per-tool allow/deny flags comparable to Pi, Claude, or Copilot, so SWF advertises `toolSelection: false` and rejects workflows requiring that capability.

Sources:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex approvals and security](https://developers.openai.com/codex/agent-approvals-security)

## Claude Code

SWF uses print mode with `stream-json`. The initialization and result events expose the session ID, model, tools, usage, and client-side cost estimate. The adapter retains the session ID and resumes with `--resume`; tool availability and automatic permission rules are reapplied on follow-up turns. Claude's documentation explicitly describes `total_cost_usd` as an estimate, so SWF classifies it as estimated rather than exact. SIGTERM/interrupt cancellation terminates the in-progress turn and process tree according to the documented headless behavior.

Sources:

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Run Claude Code programmatically](https://docs.anthropic.com/en/docs/claude-code/headless)

## GitHub Copilot CLI

SWF uses prompt mode (`--prompt`) with non-interactive tool permissions and optional model selection. The CLI supports persisted sessions and command-line resume. Current programmatic documentation describes clean text output with silent mode, but does not define a stable JSONL event protocol or machine-readable token/cost payload. SWF therefore retains the transcript, reports no structured events, and classifies usage as unknown rather than zero. Tool allow and deny rules remain fully represented in the launch and resume commands.

Sources:

- [Run Copilot CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

## Capability validation

A workflow that requests a capability an adapter does not advertise fails before a Herdr pane is created. Availability also checks the harness executable and corresponding Herdr agent-status integration. Authentication is checked directly when the CLI exposes a non-interactive status command (Codex and Claude); Copilot authentication failures are surfaced by launch because its documented command interface does not expose an equivalent status operation.

# Harness adapters

Adapters receive the concrete model selected by the service. They must advertise capabilities and validate the selected route before launch. SWF records the semantic tier, concrete model, harness, mapping provenance, fallback, contract fingerprint, and prompt-input fingerprint with each invocation. Retries retain the same route unless an operator changes configuration.
