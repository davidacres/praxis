---
**Created:** 2026-10-24T10:52:31.953Z
id: FX-BE-176
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
issue: ../../../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-176-chat-project-assignment/issue.md
---

# Assign chats to projects from Easy Mode

**Type:** Story
**Status:** 📋 To Do
**Priority:** P2

## User impact

Assign chats to projects from Easy Mode. Users retain a choice of layouts with predictable conversation organization and ownership.

## Scope and acceptance criteria

- Provide both direct project drop assignment and an accessible menu/dialog alternative for root AI conversations and persisted team chats.
- Project targets remain discoverable in the single-project-focused sidebar; list only eligible projects from the active workspace.
- Preserve transcript, identity, runtime ancestry and ticket association under existing validation rules; clearly report failures.
- Project assignment updates durable ownership, whereas dragging within groups updates presentation only.

## Dependencies

FX-BE-174, FX-BE-175

## Implementation tasks

- [TASK-471 — Add validated project drop targets for AI conversations](tasks/task-471-session-project-drops.md)
- [TASK-472 — Include persisted team chats with explicit ownership semantics](tasks/task-472-team-chat-assignment.md)

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Close when

All acceptance criteria and task done conditions are verified, with exact test and live-app evidence recorded.

## Issue mirror

[FX-BE-176](../../../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-176-chat-project-assignment/issue.md)

## Description


## Comments


