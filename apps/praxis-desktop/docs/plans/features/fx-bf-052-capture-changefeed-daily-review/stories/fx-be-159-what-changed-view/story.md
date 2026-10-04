---
**Status:** 📋 Proposed
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-159
type: Story
status: Backlog
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

- [ ] Define a unified change-event model over existing signals
- [ ] Implement aggregation and grouping (day + source) with filters
- [ ] Deep links to ticket / plan / session / commit subjects
- [ ] E2E coverage for grouping, filters, empty state, and navigation

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


