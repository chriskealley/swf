# Troubleshooting execution defaults

If a phase is blocked before Herdr starts, run `swf model routes`. The output identifies the unresolved `modelTiers.<tier>.<harness>` path. Bind it explicitly with `swf model map <tier> <harness> <model>`, review the preview, and apply it.

If Verifying reports a gap, run `swf check discover`, review the exact candidate commands, then adopt only the checks you want. Discovery never executes scripts. A checked OpenSpec task without current implementation and verification evidence remains unverified.

If delivery fails, inspect `swf delivery status` and the run dossier before retrying. SWF preserves owned resources on conflict or hosted failure. Do not manually remove nearby Herdr panes, worktrees, or branches unless they are confirmed outside the run ownership record.

Projects created before template metadata existed require manual reconciliation. SWF will report that condition and will not replace their committed `.swf/` files automatically.
