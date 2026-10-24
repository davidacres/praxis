---
**Created:** 2026-10-24T10:52:31.954Z
id: TASK-467
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-174
---

# Document the parity contract and resolve organization semantics

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Review App.tsx, Sidebar.tsx, EasyModeSidebar.tsx, EasyModeSessionsList.tsx, SessionOrganizer.tsx and AssignSessionDialog.tsx. Record entity eligibility, persistence keys, project/workspace scoping, filtering and assignment behavior before coding.

## Done when

- A behavior matrix distinguishes shared functionality from intentional layout differences.
- Define stable project-scoped manual order, independent of activity timestamps; do not migrate or discard Classic recency-bucket layouts.
- Choose explicit handling for search, Show more, selected/attention sessions and archived items, as specified by the feature.

## Dependencies

None

## Validation

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-174](../story.md)

## Description


## Comments


