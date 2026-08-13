# Troubleshooting execution defaults

If a phase is blocked before Herdr starts, run `swf model routes`. The output identifies the unresolved `modelTiers.<tier>.<harness>` path. Bind it explicitly with `swf model map <tier> <harness> <model>`, review the preview, and apply it.

If Verifying reports a gap, run `swf check discover`, review the exact candidate commands, then adopt only the checks you want. Discovery never executes scripts. A checked OpenSpec task without current implementation and verification evidence remains unverified.

If delivery fails, inspect `swf delivery status` and the run dossier before retrying. SWF preserves owned resources on conflict or hosted failure. Do not manually remove nearby Herdr panes, worktrees, or branches unless they are confirmed outside the run ownership record.

If a command stops unexpectedly, run `swf status <change>`. Configuration and dependency failures require the displayed setup/configuration action; recoverable infrastructure and harness failures normally retain the bound run and recommend `swf run <change>` or reconciliation. Failed work and checks identify the affected phase and retained evidence. An ambiguous shorthand lists the minimum `--phase`, `--gate`, `--invocation`, or `--run` selectors and performs no mutation.

In automation, use `--json --no-interactive`. Parse the single versioned stdout document and check the process exit code. Progress is never mixed into JSON stdout.

Projects created before template metadata existed require manual reconciliation. SWF will report that condition and will not replace their committed `.swf/` files automatically.
