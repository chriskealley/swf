# Delivery and release policy

The Releasing phase does not launch a general-purpose harness agent. It validates prior phase completion and current evidence, refreshes release state before delivery, records source and target commits, and requires a release-specific approval under manual policy. Autonomous delivery requires recorded delegated authorization scoped to the run or delivery action; Planning approval never authorizes merge.

Local branch, pull-request, and direct-merge behavior remains explicitly configured in `.swf/workflows/*.yaml` and constrained by policy. A merge or hosted failure retains the source branch, worktree, dossier, and owned diagnostics. Cleanup runs only after durable delivery evidence and removes only resources in the run ownership record.

OpenSpec archiving is a separate operator action. A completed delivery does not archive a change unless the operator explicitly invokes the archive workflow.
