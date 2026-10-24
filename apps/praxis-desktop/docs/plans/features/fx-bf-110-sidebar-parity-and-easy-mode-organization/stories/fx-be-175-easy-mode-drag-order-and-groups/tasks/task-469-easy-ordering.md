---
**Created:** 2026-10-24T10:52:31.955Z
id: TASK-469
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-175
---

# Add persistent Easy Mode ordering and predictable filtered views

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Wire SessionOrganizer to EasyModeSessionsList and EasyModeSessionCard with explicit drag handles and before/after indicators. Review sessionOrganizer.css and reuse theme tokens.

## Done when

- Pointer drag changes order and persists after restart; session activity updates do not undo manual order.
- Search and Show more are views of the full layout; hidden entries retain their positions and membership.
- Disable reorder/group mutation while search is active and explain why; reveal the full eligible list when organizing an unfiltered list.
- Selected and attention sessions stay discoverable, including a visible attention summary for collapsed groups; provide keyboard Move up/down and cancel behavior.

## Dependencies

FX-BE-174

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-175](../story.md)

## Description


## Comments


