---
**Created:** 2026-10-24T10:58:02.580Z
id: FX-BE-178
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
issue: ../../../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-178-easy-mode-ticket-suggestions/issue.md
---

# Suggest the next ticket from recent work in Easy Mode

**Type:** Story
**Status:** 📋 To Do
**Priority:** P2

## User impact

Discover a relevant next ticket from recent work without leaving the Easy Mode sidebar or scanning the full backlog.

## Scope and acceptance criteria

- Render one suggested ticket in a visually floating, themed card between Sessions and Runs, immediately above the Runs header. Keep it in normal sidebar flow with spacing, border and subtle elevation; it must not obscure runs, drag targets or session cards at narrow widths.
- Show ticket key, title, status, a short evidence-based reason (for example, “Related to your recent session on X”), and a position indicator such as 2 of 5. Opening the ticket is an explicit action using existing navigation.
- Previous/Next buttons browse a bounded, deduplicated, ranked candidate set without changing selection, assigning a session, starting a run or mutating tickets. Disable Previous at the first item and Next at the last; disable both for one item. Support keyboard activation, accessible names and a polite announcement of the changed ticket.
- Scope candidates and evidence to the focused project and its authorized board. Use recent project sessions and recent work metadata already available through supported APIs; exclude archived/deleted/done tickets and tickets already represented by an active session or run. Resolve done by workflow category, not a hard-coded status name.
- Recommend a deterministic first version: bounded recent window (initially 14 days, evaluated against fixtures), explicit session-ticket relationships first, related ticket links/dependencies next, then title/label overlap with recent session titles or ticket metadata. Apply recency decay and stable ticket-ID tie-breaking. Exclude candidates known to be blocked by unfinished prerequisites; use available dependency data only and never imply readiness when it cannot be established.
- Deduplicate by connection/board/ticket identity. Return structured evidence for every score; omit candidates with no supporting relevance signal rather than displaying arbitrary backlog tickets. Do not inspect raw transcripts or send additional data to a model in the first version.
- Refresh on project changes, session terminal transitions and ticket updates through existing data subscriptions or bounded invalidation. Keep the displayed ticket by identity when it remains eligible; otherwise choose the nearest valid position. Do not rerank on streamed tokens or each render. Cancel/ignore stale asynchronous results from previous projects.
- Handle loading, unavailable board, errors, no history and no relevant candidates with a compact honest state and retry where useful. Never display another project's cached suggestion or fabricate a relevance reason.

## Architecture and implementation order

Inspect App.tsx board/session ownership and existing ticket navigation before wiring data. Build a pure ranker with typed metadata inputs and injectable time; place shared main/renderer logic in core with types-only renderer imports and IPC delivery if needed, otherwise keep renderer-only logic browser-safe. Add a small EasyModeTicketSuggestion component beside the existing sidebar components, composed in EasyModeSidebar.tsx before the Runs section. Keep candidate loading and invalidation outside the presentation component. Reuse theme tokens, tooltip and icon-button primitives. No model call or new background session is required.

## Dependencies

FX-BE-174. Independent of drag/grouping delivery; FX-BE-177 must include this story in final verification.

## Implementation tasks

- [TASK-474 — Rank relevant tickets from recent project work](tasks/task-474-rank-ticket-suggestions.md)
- [TASK-475 — Add the floating single-ticket suggestion panel](tasks/task-475-ticket-suggestion-panel.md)

## Validation

- Unit-test ranking with a fixed clock: recency, explicit links, relevance, ties, deduplication, eligibility, custom workflow categories and missing dependency data.
- Add focused Easy Mode e2e coverage for location, previous/next boundaries, ticket navigation, zero/one/many results, project switching, stale results and live session/ticket invalidation.
- Build core, renderer and desktop, run check-types, copy-renderer, focused e2e and npm run test:desktop. Use temporary fixture write paths only.
- Verify pointer and keyboard use in the actual loaded Electron app at narrow and normal sidebar widths and in light/dark themes. Inspect screenshot diffs and retain useful evidence under .praxis/session-artifacts/.

## Close when

Both tasks and all acceptance criteria are evidenced, suggestions remain project-scoped and explainable, and browsing does not trigger work or ownership changes.

## Issue mirror

[FX-BE-178](../../../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-178-easy-mode-ticket-suggestions/issue.md)

## Description


## Comments


