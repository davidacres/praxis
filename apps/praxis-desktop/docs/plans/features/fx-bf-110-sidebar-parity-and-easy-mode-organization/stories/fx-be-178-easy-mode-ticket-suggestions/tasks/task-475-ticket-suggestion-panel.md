---
**Created:** 2026-10-24T10:58:02.583Z
id: TASK-475
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-178
---

# Add the floating single-ticket suggestion panel

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Compose a themed single-ticket card immediately above Runs with Previous/Next, position, reason and explicit Open ticket action. Integrate TASK-474 results and honest empty/loading/error states.

## Done when

Focused e2e and live pointer/keyboard checks prove boundaries, navigation, stable selection, project switching and non-overlapping narrow-width layout. Useful screenshots are retained; full verification includes FX-BE-177.

## Dependencies

TASK-474

## Validation

- Unit-test ranking with a fixed clock: recency, explicit links, relevance, ties, deduplication, eligibility, custom workflow categories and missing dependency data.
- Add focused Easy Mode e2e coverage for location, previous/next boundaries, ticket navigation, zero/one/many results, project switching, stale results and live session/ticket invalidation.
- Build core, renderer and desktop, run check-types, copy-renderer, focused e2e and npm run test:desktop. Use temporary fixture write paths only.
- Verify pointer and keyboard use in the actual loaded Electron app at narrow and normal sidebar widths and in light/dark themes. Inspect screenshot diffs and retain useful evidence under .praxis/session-artifacts/.

## Parent story

[FX-BE-178](../story.md)

## Description


## Comments


