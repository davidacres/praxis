---
**Status:** ✅ Done
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-462
title: Add board entry points and the Scheduled runs lineup page
status: Done
story: FX-BE-147
updated: 2026-10-24
dependencies: [TASK-383, TASK-384]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Add board entry points and the Scheduled runs lineup page

## Goal

Let a user start a schedule from the board and see every schedule in one place.

## Done when

- The board toolbar has a *Schedule run* button, and selecting tickets shows a
  selection bar with *Schedule run…*, a count and an estimate.
- A *Scheduled runs* page in the navigation lists schedules grouped as Running now,
  Up next, Needs attention (missed, paused) and Finished, each with its ordered
  tickets as a mini belt.
- A missed schedule offers *Start now* and *Skip*; nothing starts on its own.
- Only board tickets can be selected; sessions are not an entry point.

## Notes

Follow the lineup and board-entry mockups in `.praxis/session-artifacts/scheduled-runs-v2/`
and `scheduled-runs/1-board-entry.png`.

## Description


## Dependencies


## Comments

**2026-10-20:** Done: the Scheduled runs page (`ScheduledRunsPage.tsx`) grouping a project's schedules as Running now / Up next / Needs attention / Drafts / Finished with each run's tickets as a mini belt; a *Scheduled runs* row under each project in the sidebar and a command-palette entry (both behind the preview); a clock button on the board toolbar that opens the project's schedules; *Start now* / *Skip* for a missed run, which never starts on its own. A scheduled run whose time has come reads "due now" rather than being flagged as late.

**Not done:** the board selection bar (check cards, then *Schedule run…* with a count and estimate). `BoardView`'s cards are a drag-and-drop surface and this change kept to one toolbar button rather than adding checkboxes to every card; ticket selection happens in the composer's hopper instead. The cost estimate in the mockup is also not shown, since the budget decision is allowance-based and the runner's cost model does not exist yet.

## Delivery status (2026-10-24)

Board toolbar and selection actions create or append schedules; the titlebar opens the grouped schedule lineup. Missed runs require Start now or Skip. Electron coverage verifies entry points, selection, grouped navigation and restart persistence.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
