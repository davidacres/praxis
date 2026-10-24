---
**Created:** 2026-10-24T10:52:31.956Z
id: TASK-472
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-176
---

# Include persisted team chats with explicit ownership semantics

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Expose project team chats in the Easy Mode conversation feed using TeamChatRow/useProjectTeamChats. Inspect TeamChatStore, AssistantProvider and assistant IPC before adding a typed reassignment operation; do not send team-chat IDs to the AI session API.

## Done when

- Persisted team chats can be assigned via the same project tray and menu; update store ownership, source/destination lists and active assistant context together.
- Preserve chat ID, messages and participants; unsaved drafts are not draggable persisted chats.
- Validate ticket links against the destination project; never silently keep an invalid link or erase one. Show a themed decision if the existing assignment policy requires unlinking.
- Failure preserves original ownership and layout; successful moves remove only source membership and appear once in the destination.
- Team chats support the same Easy Mode ordering/grouping lifecycle while remaining a distinct typed entity.

## Dependencies

TASK-471

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-176](../story.md)

## Description


## Comments


