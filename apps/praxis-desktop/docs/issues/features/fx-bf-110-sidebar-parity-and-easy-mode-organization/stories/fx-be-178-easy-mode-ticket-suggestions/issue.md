---
id: FX-BE-178
type: Story
status: Backlog
updated: 2026-10-24
feature: FX-BF-110
---

# Suggest the next ticket from recent work in Easy Mode

**Type:** Story
**Status:** Backlog
**Priority:** P2

## Plan

[Canonical story, tasks and validation](../../../../../plans/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-178-easy-mode-ticket-suggestions/story.md)

## User impact

Find a relevant next ticket in a floating single-item panel above Runs, with previous/next browsing and a reason grounded in recent project work.

## Scope and acceptance criteria

- Render one suggested ticket in a visually floating, themed card between Sessions and Runs, immediately above the Runs header. Keep it in normal sidebar flow with spacing, border and subtle elevation; it must not obscure runs, drag targets or session cards at narrow widths.
- Show ticket key, title, status, a short evidence-based reason (for example, “Related to your recent session on X”), and a position indicator such as 2 of 5. Opening the ticket is an explicit action using existing navigation.
- Previous/Next buttons browse a bounded, deduplicated, ranked candidate set without changing selection, assigning a session, starting a run or mutating tickets. Disable Previous at the first item and Next at the last; disable both for one item. Support keyboard activation, accessible names and a polite announcement of the changed ticket.
- Scope candidates and evidence to the focused project and its authorized board. Use recent project sessions and recent work metadata already available through supported APIs; exclude archived/deleted/done tickets and tickets already represented by an active session or run. Resolve done by workflow category, not a hard-coded status name.
- Recommend a deterministic first version: bounded recent window (initially 14 days, evaluated against fixtures), explicit session-ticket relationships first, related ticket links/dependencies next, then title/label overlap with recent session titles or ticket metadata. Apply recency decay and stable ticket-ID tie-breaking. Exclude candidates known to be blocked by unfinished prerequisites; use available dependency data only and never imply readiness when it cannot be established.
- Deduplicate by connection/board/ticket identity. Return structured evidence for every score; omit candidates with no supporting relevance signal rather than displaying arbitrary backlog tickets. Do not inspect raw transcripts or send additional data to a model in the first version.
- Refresh on project changes, session terminal transitions and ticket updates through existing data subscriptions or bounded invalidation. Keep the displayed ticket by identity when it remains eligible; otherwise choose the nearest valid position. Do not rerank on streamed tokens or each render. Cancel/ignore stale asynchronous results from previous projects.
- Handle loading, unavailable board, errors, no history and no relevant candidates with a compact honest state and retry where useful. Never display another project's cached suggestion or fabricate a relevance reason.

## Dependencies

FX-BE-174

## Validation and close conditions

Use the canonical story's tests and live-app evidence; close only after all its acceptance criteria pass.
