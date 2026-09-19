---
name: openroad-next
description: Select and start the highest-priority eligible ready roadmap item without disrupting concurrent active work.
---

# OpenRoad next

Use this skill when the user asks what to work on next or asks to start the next roadmap change.

1. Run `openroad doctor`, then run `openroad next --json` and inspect active OpenSpec changes.
2. Use the returned item, which is selected from `ready` work whose `Depends on` items are all `done`.
3. If the command returns no item, report its diagnostics and do not manufacture work.
4. Never duplicate an active change or bypass the CLI's eligibility result.
5. Existing active items do not prevent selection. In particular, continue past active items whose `Work state` is `blocked` or `paused`.
6. Confirm the selected outcome and derive a short kebab-case change name. Use the installed OpenSpec workflow to create/propose the change.
7. Only after creation succeeds, run `openroad start <roadmap-id> --change <change-name> --json`.
8. If start fails, report its diagnostics and leave the roadmap unchanged; do not hand-edit around a failed precondition.
9. Run `openroad doctor` after start succeeds.

Never assume there can be only one active OpenSpec change. Do not patch OpenSpec-generated skills.
