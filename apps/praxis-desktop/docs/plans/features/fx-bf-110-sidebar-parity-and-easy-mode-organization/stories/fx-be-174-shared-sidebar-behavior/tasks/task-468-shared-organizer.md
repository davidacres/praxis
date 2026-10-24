---
**Created:** 2026-10-24T10:52:31.955Z
id: TASK-468
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-174
---

# Reuse the organizer with stable identity and mode compatibility

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Adapt the existing renderer SessionOrganizer rather than adding an Easy-only drag engine. Keep rendering callbacks and layouts mode-specific; extract pure transforms only where they improve validation and reuse.

## Done when

- Stable IDs distinguish sessions, team chats and presentation groups; switching projects cannot reuse another project's in-memory layout.
- No renderer runtime value imports from core; put shared serializable ownership contracts in core only if needed.
- Existing Classic persisted groups and drag behavior survive unchanged unless an explicit tested migration is required.

## Dependencies

TASK-467

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-174](../story.md)

## Description


## Comments


