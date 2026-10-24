---
id: FX-BE-175
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
---

# Add Easy Mode drag ordering and named groups

**Type:** Story
**Status:** Backlog
**Priority:** P2

## Plan

[Canonical story and acceptance criteria](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-175-easy-mode-drag-order-and-groups/story.md)

## User impact

Add Easy Mode drag ordering and named groups. Users retain a choice of layouts with predictable conversation organization and ownership.

## Scope and acceptance criteria

- Reorder eligible root AI conversations and groups by real pointer drag, with durable project isolation.
- Create, rename, collapse, reorder, join, leave and dissolve flat groups without changing project ownership or runtime ancestry.
- Subagents and workflow stage sessions remain nested under their owner; Runs stay in their existing section and cannot become chat groups.
- Filtering, folding and live updates never overwrite the full saved order; preserve selected/attention visibility and keyboard accessibility.

## Dependencies

FX-BE-174

## Implementation tasks

- [TASK-469 — Add persistent Easy Mode ordering and predictable filtered views](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-175-easy-mode-drag-order-and-groups/tasks/task-469-easy-ordering.md)
- [TASK-470 — Add named group lifecycle and accessible move operations](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-175-easy-mode-drag-order-and-groups/tasks/task-470-easy-groups.md)

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Close when

All acceptance criteria and task done conditions are verified, with exact test and live-app evidence recorded.


