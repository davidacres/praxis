---
**Created:** 2026-10-24T10:52:31.957Z
id: TASK-473
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-177
---

# Prove organization and assignment in the loaded desktop app

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Add focused Playwright coverage and meaningful layout-transform/ownership tests where implementation changes require them. Build and copy the renderer, run focused and full desktop coverage, then verify the loaded app with actual mouse movement.

## Done when

- Cover order/groups across restart, project switching and mode toggles; search/folding/live updates; group accessibility and cancelled drags.
- Cover AI conversation and team-chat assignment, stale targets, failed mutations, ticket-link policy, same-project drops and mixed MIME payloads.
- Verify Classic recency feed, existing groups, team chats, navigation, run expansion and assignment are unaffected.
- Run check-types, builds, focused specs and npm run test:desktop; record exact results and any incomplete suites without claiming success.
- Retain useful before/after screenshots and publish evidence at handoff; inspect snapshot diffs deliberately.

## Dependencies

FX-BE-175, FX-BE-176, FX-BE-178

## Validation

- Include FX-BE-178 suggestion ranking, carousel controls, project isolation and floating-panel layout in focused and live verification.

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

## Parent story

[FX-BE-177](../story.md)

## Description


## Comments


