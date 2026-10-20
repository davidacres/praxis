---
**Status:** ✅ Done
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-384
title: Build ticket picker, start-time, and order editor
status: Done
story: FX-BE-147
updated: 2026-10-20
dependencies: [TASK-383]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Build ticket picker, start-time, and order editor

## Goal

Add the user-facing schedule editor for selecting tickets, choosing the
scheduled start, and arranging the sequential running order.

## Done when

- The editor supports adding, removing, and reordering tickets with keyboard and
  pointer controls.
- The selected start time is shown with timezone context and validation.
- Readiness warnings appear before save when tickets, workflows, providers, or
  policies are not launchable.
- Reopening a saved schedule shows the same ordered queue.
- Tickets are picked from a hopper and dropped on a belt whose left-to-right
  order is the run order; the estimate and provider headroom update as tickets
  are added.
- There is no repeat control and no dollar-cap control; the budget panel shows
  provider allowance headroom instead.

## Notes

Keep the editor compact and operational. This is a work surface, not a landing
page.

## Description


## Dependencies



## Comments

**2026-10-20:** Built as `renderer/src/schedule/ScheduleComposer.tsx` (+ `schedule.css`), behind the `preview.enableScheduledRuns` setting (off by default, because the runner does not exist yet and a saved schedule would otherwise look like it will fire). A hopper of the project's unfinished tickets, a belt whose order is the run order (add by click or drag, reorder by drag or by earlier/later buttons, remove), start date/time/timezone, an armed-processor preview, and a readiness panel fed by `scheduledRuns.preview`. Reopening a schedule restores the same ordered queue. Spec: `e2e/scheduledRuns.spec.ts` (belt order by button and by drag, save, restart, edit, arm/hold/delete, no-provider blocker, the preview gate); the drag guard was proven to fail with the drop handler disabled.

Deviations from the v2 mockup: the belt is a vertical list rather than a horizontal strip, to fit the centre pane; the budget gauge is replaced by a policy panel, since the budget decision is provider allowance (95% hand-over) rather than a per-run dollar cap.
