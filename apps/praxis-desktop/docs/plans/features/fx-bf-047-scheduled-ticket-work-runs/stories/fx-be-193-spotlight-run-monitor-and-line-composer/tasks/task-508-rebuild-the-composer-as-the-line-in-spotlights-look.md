---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-508
title: Rebuild the composer as the Line in Spotlight's look
status: To Do
story: FX-BE-193
updated: 2026-11-02
dependencies: [TASK-506]
validation: [npm run check-types, npm run build:renderer, npm run desktop:copy-renderer, npm run test:desktop]
---

# Rebuild the composer as the Line in Spotlight's look

## Goal

Restyle `ScheduleComposer.tsx` to the chosen design (canvas board `F-New`).
Keep its rules and keyboard paths.

## Done when

- **Header:** an editable schedule name at title size, and the start time
  large with "likely done" and spend beside it, matching the monitor's header.
- **Run order as bays:** each step is a bay and tickets in one bay share it.
  Cards use the monitor's card style. The existing earlier, later, share-step
  and remove buttons and the drag targets still work (`scheduleFlow.ts` is
  unchanged).
- **Readiness on the ticket:** issues with an `entryId` (no acceptance
  criteria, moved, closed, in another schedule, no folder) show on that card.
  Run-wide issues stay in "Before it starts".
- **Rehearsal:** the bead rail from `TASK-507`, played from the forecast's
  per-entry windows, with a one-line narration ("Step 3 · TASK-479 and TASK-480
  side by side · 22:41–23:05"). Under reduced motion it shows the final state
  and the step list.
- "Each ticket runs" names the chosen workflow and its tasks in order.
  "How many at once" keeps the parallel-lanes warning text.
- The schedule button reads "Schedule for <day> <time>" and is disabled with
  the first blocker as its title, as today.

## E2E updates (same change, not a follow-up)

Keep the composer's test ids wherever their meaning survives. Most composer
tests then need little or no change. The full list is in the story's "E2E
tests that use these screens".

- **Ids that stay:** `schedule-composer`, `schedule-name`, `schedule-date`,
  `schedule-time`, `schedule-timezone`, `schedule-workflow`, `schedule-lanes`,
  `schedule-lanes-warning`, `schedule-save`, `schedule-save-draft`,
  `schedule-run-now`, `schedule-cancel`, `schedule-count`, `schedule-summary`
  (the header sentence), `schedule-hopper`/`schedule-hopper-card` (picker),
  `schedule-belt` (the run-order area), `schedule-belt-card` (a ticket in a bay,
  with `-key`, `-title`, `-seq`), `schedule-flow-step` (a bay, with its
  `data-step`), and `schedule-flow-join-preview` (drop-to-share highlight).
- **Ids that go, with what replaces them:**
  - `schedule-flow-bar` / `schedule-flow-rails` (how a shared step was drawn):
    test 349 instead asserts two `schedule-belt-card`s inside one
    `schedule-flow-step`.
  - `schedule-belt-slot`: test 315 uses `schedule-flow-step` order.
  - `schedule-ready` / `schedule-readiness`: keep `schedule-readiness` on
    "Before it starts" and `schedule-ready` on its all-clear line. Per-ticket
    issues are asserted on the card (`schedule-belt-card [data-code]`) in tests
    94, 229 and 462.
- **Tests:** 94, 154, 229, 315, 349, 416, 462, 510, 634, 848 (editor half),
  1069, 1137. Test 349's saved-steps assertion and 1137's
  lanes-survive-saving assertion are behaviour and must not be weakened.
- **New:** the rehearsal shows one `schedule-rail` bead per ticket in run
  order. Its likely finish equals the `scheduledRuns.preview` forecast for the
  same input.

## Verification

- `npx playwright test e2e/scheduledRuns.spec.ts` passes in full, including
  keyboard-only ordering and both drag paths (hopper → bay, card → bay).
- Re-inspect the composer screenshots the spec writes
  (`scheduled-run-composer.png`, `scheduled-run-flow-graph.png`,
  `scheduled-run-flow-graph-drag.png`, `scheduled-run-dragged-group.png`,
  `scheduled-run-sidebar-composer.png`, `scheduled-run-now-composer.png`,
  `scheduled-run-parallel-editor.png`, `scheduled-run-from-request-file.png`)
  and compare an empty, part-filled and ready composer with the canvas board.

## Dependencies

- `TASK-506`
- `TASK-507` (shares the bead rail and card components; build those first)

## Description


## Comments

