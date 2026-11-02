---
**Status:** 📋 To Do
**Created:** 2026-11-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-507
title: Build the Spotlight run monitor
status: To Do
story: FX-BE-193
updated: 2026-11-02
dependencies: [TASK-504, TASK-505, TASK-506]
validation: [npm run check-types, npm run build:renderer, npm run desktop:copy-renderer, npm run test:desktop]
---

# Build the Spotlight run monitor

## Goal

Replace the belt/processor layout of `ScheduleRunMonitor.tsx` with the
Spotlight design (canvas board `D-Spotlight-Monitor`).

## Done when

- **Header:** run name, status pill, current time, "likely done" from the
  forecast, spend so far, plus Pause/Resume, Stop and a link to the report.
- **Bead rail:** one bead per entry in run order, gaps between steps, states
  queued, running, waiting, failed, done, skipped.
- **Up next:** waiting entries as a stacked deck, showing step and the reason it
  waits (the lanes panel's existing `why` text).
- **In flight:** one card per entry in `lives`, sized to share the space by
  lane count. Each card shows key, title, lane, provider (and a hand-over note
  when one happened), the task list from `stages` (state icon, name, attempts
  when more than one, elapsed or duration), the activity line, and time, tokens
  and cost.
- **Decisions on the card:** approval (`approveGate`), failure (`retryStage`
  or `retryEntry`, `skipEntry`), trust (`confirmProjectWorkflowTrust` then
  `resume`) and launch-interrupted all render on the card they concern, with
  the same calls the current banner makes. A pause about no entry (budget,
  no provider, user) stays a header banner.
- **Delivered:** finished and skipped entries as receipts, newest first, with
  duration, spend and a link to the workflow run.
- **Motion:** cards move deck → stage → receipts. Under
  `prefers-reduced-motion` and the app's reduced-motion setting they appear in
  place, and no element pulses or spins.
- Provider allowance moves into a compact footer row, keeping the hand-over
  threshold text.
- The old belt, processor, Done tray and Lanes panel are removed, along with
  `live` once nothing reads it.

## E2E updates (same change, not a follow-up)

The monitor tests in `e2e/scheduledRuns.spec.ts` fail as soon as the belt and
processor go, so update them in this change. The full list is in the story's
"E2E tests that use these screens". Per test:

- **769** budget pause before launch: assert the header pause banner (no entry,
  so it stays in the header). Replace `schedule-processor` with "no
  `schedule-flight-card`" and the ticket still in `schedule-deck`. Replace
  `schedule-budget` with the footer allowance row (keep `data-provider`).
- **807, 831** Run now opens the live view: `schedule-monitor` and
  `schedule-monitor-back` keep their ids, so only checks on the old layout
  change.
- **848** Run now from the editor hits the budget gate: same as 769.
- **865** launch interrupted: the reason and Skip move onto the deck card for
  that entry. `schedule-done-tray` becomes the receipts column
  (`schedule-receipt` with `data-entry-status="skipped"`). Resume stays in the
  header.
- **920, 960** failed stage: `schedule-proc-state` and `schedule-stage-failure`
  become the failed `schedule-task-row` (`data-lane="failed"`) and the error
  detail on the flight card. Retry stage, Retry ticket and "Open workflow and
  logs" are on the card. Test 960's point stays: the card names the failed
  stage, not the paused one beside it.
- **1007** missing tool refused before start: header banner, unchanged apart
  from the selector.
- **1168** two lanes, a third waits: replace the lanes panel with two
  `schedule-flight-card`s (one per `data-lane`), and the waiting ticket's
  reason on its deck card (`schedule-lane-reason` stays as the id of that
  text).
- **1204** one lane and why: `schedule-activity` is gone. Assert the reason on
  the deck card, and the run event through `scheduledRuns.get` (the ledger
  still records it).
- **1265** blocked readiness starts nothing: header banner plus no
  `schedule-flight-card`.
- **1282** untrusted workflow: header banner (the pause is about the run) with
  `schedule-trust-workflow`, unchanged behaviour.
- **New:** a two-lane run with the fake agents. Two flight cards each show the
  workflow's task rows. One finishes and becomes a `schedule-receipt`. A
  Review → Implement loop shows Implement running with attempts 2.

## Verification

- `npx playwright test e2e/scheduledRuns.spec.ts` passes in full (all tests,
  not only the monitor ones), after `npm run build:renderer` and
  `npm run desktop:copy-renderer`.
- `npm run test:desktop:smoke` passes (it includes
  `scheduledProviderHandover.spec.ts`).
- Re-inspect every monitor screenshot the spec writes
  (`scheduled-run-monitor-budget-pause.png`, `scheduled-run-now-live.png`,
  `scheduled-run-monitor-launch-paused.png`, `scheduled-run-stage-failure.png`,
  `scheduled-run-missing-tool.png`, `scheduled-run-parallel-monitor.png`) and
  compare each with the canvas board before reporting done.

## Dependencies

- `TASK-504`
- `TASK-505`
- `TASK-506`

## Description


## Comments

