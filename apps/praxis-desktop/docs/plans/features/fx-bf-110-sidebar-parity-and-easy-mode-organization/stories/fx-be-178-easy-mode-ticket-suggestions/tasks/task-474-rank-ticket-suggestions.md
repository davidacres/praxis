---
**Created:** 2026-10-24T10:58:02.582Z
id: TASK-474
type: Task
status: Backlog
updated: 2026-10-24
story: FX-BE-178
---

# Rank relevant tickets from recent project work

**Type:** Task
**Status:** 📋 To Do
**Priority:** P2

## Goal and implementation scope

Inspect the available board, dependency and session metadata APIs; implement bounded deterministic candidate ranking, eligibility and evidence. Wire project-scoped invalidation with stale-response protection.

## Done when

Fixed-clock unit tests prove the ranking and exclusions in FX-BE-178. No model calls, transcript reads or token-stream reranking. Empty/missing data is explicit and project scope is enforced.

## Dependencies

FX-BE-174

## Validation

- Unit-test ranking with a fixed clock: recency, explicit links, relevance, ties, deduplication, eligibility, custom workflow categories and missing dependency data.
- Add focused Easy Mode e2e coverage for location, previous/next boundaries, ticket navigation, zero/one/many results, project switching, stale results and live session/ticket invalidation.
- Build core, renderer and desktop, run check-types, copy-renderer, focused e2e and npm run test:desktop. Use temporary fixture write paths only.
- Verify pointer and keyboard use in the actual loaded Electron app at narrow and normal sidebar widths and in light/dark themes. Inspect screenshot diffs and retain useful evidence under .praxis/session-artifacts/.

## Parent story

[FX-BE-178](../story.md)

## Description


## Comments


