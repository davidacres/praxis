---
**Created:** 2026-10-24T10:52:31.955Z
id: TASK-470
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-175
---

# Add named group lifecycle and accessible move operations

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Support creating a group by a deliberate center drop, adding/removing members, moving groups, renaming, collapsing and ungrouping. Use a flat group hierarchy and existing controls.

## Done when

- Group names, order, membership and collapse persist; ungrouping preserves every conversation.
- Before/after insertion is visually distinct from create/join group; invalid payloads and cross-project layout drops have no effect.
- Drag handles do not trigger row selection, rename, archive, delete, abort or assignment buttons.
- Provide keyboard/menu alternatives for create group, move to group and remove from group; Escape cancels without changing saved layout.
- Archiving/deletion/reappearance reconcile IDs without duplicates or wiping hidden layout records.

## Dependencies

TASK-469

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-175](../story.md)

## Description


## Comments


