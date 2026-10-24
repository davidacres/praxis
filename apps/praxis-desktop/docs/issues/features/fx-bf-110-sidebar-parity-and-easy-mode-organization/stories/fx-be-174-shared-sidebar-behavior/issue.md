---
id: FX-BE-174
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
---

# Define sidebar parity and shared organization behavior

**Type:** Story
**Status:** Backlog
**Priority:** P2

## Plan

[Canonical story and acceptance criteria](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-174-shared-sidebar-behavior/story.md)

## User impact

Define sidebar parity and shared organization behavior. Users retain a choice of layouts with predictable conversation organization and ownership.

## Scope and acceptance criteria

- Keep Classic navigation and Easy Mode Sessions/Runs layout; reuse behavior rather than forcing a single visual tree.
- New Easy layout uses stable workspace/project scope, survives restart and mode toggles, and does not overwrite Classic storage.
- Shared cards continue showing activity, gates, background-task status, provider/model indicators and action controls.

## Dependencies

None

## Implementation tasks

- [TASK-467 — Document the parity contract and resolve organization semantics](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-174-shared-sidebar-behavior/tasks/task-467-sidebar-parity-contract.md)
- [TASK-468 — Reuse the organizer with stable identity and mode compatibility](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-174-shared-sidebar-behavior/tasks/task-468-shared-organizer.md)

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Close when

All acceptance criteria and task done conditions are verified, with exact test and live-app evidence recorded.


