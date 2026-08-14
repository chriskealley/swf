# Live Pi/Herdr operator-guidance smoke evidence

- Date: 2026-08-13 (Australia/Perth)
- Herdr environment: `HERDR_ENV=1`
- Herdr Pi integration: current, v5
- Owned pane: `wR:pB`, label `operator-guidance-smoke`
- Model: `openai-codex/gpt-5.6-luna`
- Safety: non-interactive Pi, no session, no tools, no context files, no project approval; no repository mutation

Command executed in the owned Herdr pane:

```sh
pi -p --no-session --no-tools --no-context-files --no-approve \
  --model openai-codex/gpt-5.6-luna \
  'Return exactly the requested operator-guidance markers.'
```

Observed output:

```text
PROGRESS: Planning completed; checkpoint recorded
ATTENTION: Planning approval required
NEXT: approve, request-changes, reject
DELIVERY: local branch swf/operator-smoke -> main; dossier retained
```

The smoke demonstrates that a live Pi process supervised in an owned Herdr pane can present the same bounded progress, typed approval attention, next-action decisions, and completed local-delivery guidance covered by the shared projection contract. The pane was closed after evidence capture; no existing panes were changed.
