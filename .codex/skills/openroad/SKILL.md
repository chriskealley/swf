---
name: openroad
description: Maintain the project OpenSpec roadmap and keep it synchronized with OpenSpec change lifecycle.
---

# OpenRoad

Use this skill when the user asks to create, edit, review, or synchronize `openspec/roadmap.md`.

1. Read `openspec/roadmap.md`, `openspec/config.yaml`, and the relevant directories under `openspec/changes/`.
2. Treat `Status` as lifecycle: `planned`, `ready`, `active`, `done`, or `cancelled`.
3. Only active items have `Work state`: `available`, `blocked`, or `paused`.
4. Allow multiple active items. A blocked or paused active item does not prevent work on another eligible item.
5. Each active item must name its OpenSpec change in `Change`. Never reuse that change for another item.
6. Preserve stable roadmap IDs and explicit dependencies. Lower numeric `Priority` values rank first.
7. When an OpenSpec change is successfully archived, mark its linked item `done` and remove `Work state`. Do not infer successful archival merely from intent.
8. Run `openroad doctor` after edits and fix validation errors.

Do not edit OpenSpec-generated skills or fork an OpenSpec schema for roadmap coordination.
