---
name: openroad-next
description: Select and start the highest-priority eligible ready roadmap item without disrupting concurrent active work.
---

# OpenRoad next

Use this skill when the user asks what to work on next or asks to start the next roadmap change.

1. Read `openspec/roadmap.md`, validate it with `openroad doctor`, and inspect active OpenSpec changes.
2. Consider every item whose `Status` is `ready` and whose `Depends on` items are all `done`.
3. Exclude items already linked to a change and never duplicate an active change.
4. Select the eligible item with the lowest numeric `Priority`; break ties by roadmap ID.
5. Existing active items do not prevent selection. In particular, continue past active items whose `Work state` is `blocked` or `paused`.
6. If no item is eligible, report why and do not manufacture work.
7. Confirm the selected outcome and derive a short kebab-case change name. Use the installed OpenSpec CLI to create/propose the change according to the project's workflow.
8. Only after creation succeeds, update the roadmap item to `Status: active`, `Work state: available`, and set `Change` to the created name.
9. Preserve all unrelated roadmap content and run `openroad doctor`.

Never assume there can be only one active OpenSpec change. Do not patch OpenSpec-generated skills.
