---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-160
type: Story
status: Done
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

- [x] Define overdue/blocked/aging query rules over the board store
- [x] Build review surface with quick actions
- [x] Reviewed-marker persistence and same-day behavior
- [x] E2E coverage for surfacing, actions, transitions, and empty state

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

### 2026-10-11 — implementation evidence

Surfacing rules (Project review → Daily Review, active project only):
- **Blocked**: any unfinished item whose status contains "Blocked"; surfaced regardless of dates.
- **Inactive**: an unfinished item whose latest of `updated`, `created` and the last Praxis-observed change is **7 or more whole days** before now (local clock). An item with no date is never flagged inactive.
- **Unfinished** excludes any stage in the `done` category (or Done/Closed/Resolved/Complete when the board declares no workflow).
- Blocked items are listed first, then by age.

Actions: Move to (the board's own `issue.transition`, so only that board's transitions are offered), Add note (the board's `addComment`; a backend that refuses — app-storage tickets — shows its own message and keeps the text), and Open item. "Done reviewing" holds for the rest of the local day unless an item appears that was not in that review. Empty state links to the board.

Verified: `e2e/projectReview.spec.ts` covers blocked + inactive surfacing, a finished starter excluded, project isolation, a refused note, a move removing the item, and the same-day marker across a reload. The blocked assertion was proven to fail with the rule disabled.

Not covered: due dates — no backend in Praxis exposes one on `IssueSummary`, so "overdue" is aging only.

### 2026-10-11 — QA review against the criteria

Added to `e2e/projectReview.spec.ts`: a project with only finished work shows the "Nothing overdue or blocked" empty state with Open board (AC7). Fixed: the review's load-failure and refused-note messages now use the danger colour instead of help-text grey.

Still open: AC1 due-date overdue — the ticket schema has no due date, so only blocked and 7-day inactivity are surfaced; AC2 blocker reason — not shown, as no backend records one; AC6 two-minute review — not measured.

### 2026-10-11 — remaining criteria closed

- **AC1:** the aging threshold is configurable per project ("Flag after 3 / 7 / 14 / 30 days", kept across reloads). No backend records a due date, so this aging rule is the criterion's "or configurable aging threshold" branch. Due dates remain a separate, cross-backend schema change and are not in v1.
- **AC2:** each row tags why it was surfaced (Blocked, Aging, or both) and labels its stage.
  - A blocked item shows its blocker reason: the latest note starting `Blocked: `, or "No blocker reason recorded".
  - Moving an item into a blocked stage from the review opens a "Why is it blocked?" field. On a blocked item, Add note becomes Add reason.
  - Reasons are stored as ordinary comments, so they live with the item in every backend that supports comments. App-storage tickets still refuse comments, by name.
- **AC4/AC5:** tested.
  - After "Done reviewing", an item blocked elsewhere brings the review back on the next open.
  - Resolving that item folds the review away again, because everything left was already reviewed today.
- **AC6:** an 11-item review (every item acted on) completes in a few seconds, against a 60 s budget, with no document reload.
- **AC8:** a test checks that "Move to" offers exactly the item's board transitions and never its current stage.

Verified: `e2e/projectReview.spec.ts` 3/3, including a folder-backed test that saves a reason, finds `Blocked: …` in the markdown on disk, and still shows it after a reload. Proven to fail with the `Blocked: ` prefix dropped, and with the aging setting ignored.

### 2026-10-11 — closeout status and verification

Existing full-run log records all 3 `projectReview.spec.ts` tests passing, including configurable aging, newly blocked items after review, allowed transitions, review timing and persisted blocker reasons. The later remaining-criteria evidence supersedes earlier gap notes. V1 uses the accepted configurable-aging branch; due-date schema support remains outside this story.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.
