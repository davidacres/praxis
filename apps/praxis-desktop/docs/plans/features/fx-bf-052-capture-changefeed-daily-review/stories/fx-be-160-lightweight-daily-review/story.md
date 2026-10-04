---
**Status:** 📋 Proposed
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-160
type: Story
status: Backlog
created: 2026-10-04
priority: Medium
---

# Lightweight daily review

## Impact

A user starts their day (or a checkpoint) by opening a short, focused Daily Review that surfaces overdue and blocked work with one-click actions to re-plan, unblock, or defer — turning stalled board state into a deliberate decision instead of silent drift.

## Scope

A review surface that queries the active board for overdue tickets (past due date or aging in a non-Done column) and blocked tickets, presents them in a compact prioritized list with quick actions (open ticket, change stage, add comment/note), and records a lightweight "reviewed" marker so repeat reviews feel intentional, not nagging. No scheduling, notifications, or auto-mutation in v1 — the user opens it deliberately and every action is explicit.

## Acceptance criteria

1. The review lists all tickets in the Blocked workflow stage and all overdue tickets (due date in the past, or configurable aging threshold in a non-Done stage) for the active project.
2. Each entry shows title, stage, why it was surfaced (blocked / overdue / aging), age, and blocker reason when recorded.
3. Quick actions from the review: open the ticket, move its stage, and add a short note — without leaving the review.
4. Completing a review (explicit "Done reviewing") records a timestamp marker; the surface does not re-nag within the same day unless new items appear.
5. Items resolved during review disappear from the live list immediately; the list refreshes against current board state on open.
6. The review is reachable in one interaction and completes a typical 10-item review in well under two minutes (no full page loads per action).
7. Empty state is positive and explicit ("Nothing overdue or blocked") with a link to the board.
8. Board stage changes made from the review respect the same workflow rules as the board (no invalid transitions).

## Tasks

- [ ] Define overdue/blocked/aging query rules over the board store
- [ ] Build review surface with quick actions
- [ ] Reviewed-marker persistence and same-day behavior
- [ ] E2E coverage for surfacing, actions, transitions, and empty state

## Verification

1. Seed a board with a blocked ticket, an overdue ticket, an aging ticket, and a fresh one; confirm only the first three are surfaced with correct reasons.
2. Perform quick actions from the review; verify board reflects changes and workflow rules hold.
3. Run `npm run check-types` and desktop E2E suite.

## Dependencies

FX-BF-052. Existing board workflow (Backlog/To Do/In Progress/Blocked/Done) and ticket store. Complements FX-BE-159 (what changed) but does not depend on it.

## Close conditions

All acceptance criteria pass; surfacing rules documented in the story; follow-ups (notifications, AI-suggested next actions) listed as non-goals for v1.

## Description


## Comments


