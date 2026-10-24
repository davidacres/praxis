---
**Created:** 2026-10-24T10:52:31.956Z
id: TASK-471
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-176
---

# Add validated project drop targets for AI conversations

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Add a compact project target tray shown during a conversation drag, including the focused project and other eligible workspace projects; retain the existing AssignSessionDialog as a discoverable menu/keyboard route. Reuse App.tsx onAssignConversation and ai.assignSessionToProject.

## Done when

- Dragging an eligible standalone AI conversation onto a project invokes one ownership mutation; dropping in the same project is a no-op.
- Resolve current project eligibility at drop time; stale/deleted/out-of-workspace targets fail visibly without moving the source row.
- Reuse existing assignment validation for running sessions, ticket association and workspaceFolder semantics; preserve session identity, transcript and runtime state.
- Only persist source-layout cleanup after success; show assigned project and keep the open conversation reachable after it leaves the focused feed.
- Local ordering/grouping and project assignment use distinct payload intent and targets; do not confuse grouping with ownership changes.

## Dependencies

FX-BE-174, FX-BE-175

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-176](../story.md)

## Description


## Comments


