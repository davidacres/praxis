---
id: FX-BE-177
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
---

# Verify both sidebar modes and retain interaction evidence

**Type:** Story
**Status:** Backlog
**Priority:** P2

## Plan

[Canonical story and acceptance criteria](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-177-sidebar-parity-verification/story.md)

## User impact

Verify both sidebar modes and retain interaction evidence. Users retain a choice of layouts with predictable conversation organization and ownership.

## Scope and acceptance criteria

- All acceptance criteria have focused coverage and successful live pointer/keyboard verification in the actual loaded Electron app.
- Full desktop e2e results, snapshots and remaining limitations are explicitly recorded.
- No tests write to real plans, project/workspace files or user-owned data.

## Dependencies

FX-BE-175, FX-BE-176, FX-BE-178

## Implementation tasks

- [TASK-473 — Prove organization and assignment in the loaded desktop app](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-177-sidebar-parity-verification/tasks/task-473-sidebar-verification.md)

## Validation

- Include FX-BE-178 suggestion ranking, carousel controls, project isolation and floating-panel layout in focused and live verification.

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Close when

All acceptance criteria and task done conditions are verified, with exact test and live-app evidence recorded.


