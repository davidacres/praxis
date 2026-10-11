---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-159
type: Story
status: Done
created: 2026-10-04
priority: Medium
---

# What changed view

## Impact

A user returning to the project can open a "What changed?" view and see a time-ordered, grouped summary of recent updates — ticket/status transitions, plan changes, session activity, and git commits — without diffing folders or reading logs.

## Scope

New view (or panel) that aggregates change signals already present in the system: ticket status transitions, plan/story edits, session lifecycle events, and git log for the project repo. Deterministic grouping by day and by source, with filters. No AI summarization, no cross-project rollup, no file-level diff UI in v1.

## Acceptance criteria

1. The view lists recent changes in reverse-chronological order, grouped by day, each entry showing actor/source, what changed, and a relative timestamp.
2. Sources covered in v1: ticket created/status changed, plan/story file modified, agent session started/ended, and git commits.
3. Each entry links or navigates to its subject (ticket, plan file, session, commit) in one click.
4. Source filters (tickets / plans / sessions / git) and a time-window selector (e.g. 24h / 7d / 30d) apply without reloading the app.
5. Empty state is clear and actionable when no changes exist in the window.
6. Changes made by the user and by agent sessions are visually distinguishable.
7. Performance: rendering a 7-day window with hundreds of entries stays responsive (no blocking main-thread work over ~100ms per render).
8. The view is reachable from one interaction (sidebar node or TitleBar entry) from anywhere in the app.

## Tasks

- [x] Define a unified change-event model over existing signals
- [x] Implement aggregation and grouping (day + source) with filters
- [x] Deep links to ticket / plan / session / commit subjects
- [x] E2E coverage for grouping, filters, empty state, and navigation

## Verification

1. Make representative changes (move a ticket, edit a plan, run a session, commit); confirm each appears correctly grouped and linked.
2. Exercise filters, time windows, and empty state.
3. Run `npm run check-types` and desktop E2E suite.

## Dependencies

FX-BF-052. Existing ticket store, plan file watching, session events, git integration (FX-BF-040 session linkage).

## Close conditions

All acceptance criteria pass; covered sources are complete for v1; deferred sources (AI summaries, cross-project) listed as follow-ups.

## Description


## Comments

### 2026-10-11 — implementation evidence

Delivered in the project page's Project review → What Changed: Praxis records item create/update/status/comment/delete (observed at the `IssueTrackerService` boundary, so board, agent, mobile and workflow writes count alike) and agent-session state changes, per project, in `project-activity.json`. Retention: **30 days, at most 1,000 entries per project** (`ProjectActivityStore`, pruned on open). History starts when recording starts — imported work never fabricates past changes, and the view says so. Entries are grouped by day, filterable by source (items / agent sessions) and window (24h / 7d / 30d), open their item or session in one click, and are isolated to the active project.

Verified: `projectActivity.test.ts` (4 unit tests in `test:core`) and `e2e/projectReview.spec.ts`.

Open against the criteria: AC2 git commits and plan files edited outside Praxis are not recorded (stated in the view); AC6 user-versus-agent attribution of item edits is not recorded — only sessions are marked as agent activity.

### 2026-10-11 — AC2 and AC6 closed; remaining criteria tested

- **Plan files (AC2):** `FolderService.onDidChangePlanFile` fires for a plan markdown change Praxis did not make, and main records it as `kind: 'plan'`, actor `external`. At most one entry per file per minute, so an editor's save burst counts as one edit.
  - Praxis's own writes are recognised **by content, not by timing** (`isOwnFolderWrite` in `folderFs.ts`).
  - The old 2-second window swallowed an outside edit made just after a Praxis write; a status change rewrites the parent feature file too. This was found by the new test and fixed.
- **Git commits (AC2):** read on demand from the project's repository (last 30 days, at most 500), never copied into the store, because git is their record. `parseGitActivity` attributes each commit:
  - `you` when the author address matches the repository's `user.email`;
  - `agent` when an agent authored or co-authored it (`Co-authored-by` trailer);
  - otherwise the author's name.
- **Who (AC6):** item writes made inside `runAsAgent` are attributed to the agent; everything else is attributed to you. Agent paths are tracker tools, workflow plan publishing, feature decomposition, run write-back and ticket-review apply. Session entries are the agent's. Badges differ by fill and border style, not by hue alone.
- **Links (AC3):** Open file (the plan document preview), Open commit (the git graph with that commit selected) and Open item.
  - Fixed along the way: the panel's Open item and Open board routes included `projectId`, so project home kept the centre pane. The board never appeared and a ticket review could not open.
- **Timestamps (AC1):** relative within each day group ("12 min ago"), with the full time on hover.
- **One interaction (AC8):** a title-bar What Changed button (from any page, using the last-viewed project when none is selected), plus "What Changed" / "Daily Review" command-palette entries per project.

Verified: `e2e/whatChanged.spec.ts`.
- **Real folder project in a real git repo:** covers every source, actor badges, day grouping newest-first, filters per source, Open file / Open commit / Open item, reaching the view from Overview, and no page reload throughout.
- **600 seeded entries over 7 days:** render and filter with no main-thread task of 100 ms or more (AC7).
- **Unit tests:** `projectActivity.test.ts` (commit attribution against real git output; merge order) and `folderFs.test.ts` (own write vs an outside edit right after it; moves).
- **Proven to fail:** agent attribution forced to `you`.

### 2026-10-11 — closeout status and verification

Existing full-run log records both `whatChanged.spec.ts` tests passing: all sources, attribution, grouping/filtering/navigation and a 600-entry responsiveness case. The later AC2/AC6 implementation evidence supersedes the earlier open-gap note.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.
