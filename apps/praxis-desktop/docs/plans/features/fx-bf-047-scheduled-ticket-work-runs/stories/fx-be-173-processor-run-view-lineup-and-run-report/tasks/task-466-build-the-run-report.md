---
**Status:** ✅ Done
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-466
title: Build the run report
status: Done
story: FX-BE-173
updated: 2026-11-02
dependencies: [TASK-465]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Build the run report

## Goal

Summarise a finished run: outcome, spend, time per stage, artifacts, approvals and skipped work.

## Done when

- Totals and per-ticket rows match the ledger.
- Skipped tickets show their reason.
- Session links open the ticket's session.

## Notes

See `scheduled-runs-v2/4-run-report.html`.

**Retargeted 2026-11-02:** the report now follows the `F-Report` board on the
FX-BE-193 design canvas: "Needed you" (approvals and retries with how long
each waited), "Worth knowing" (review loops with their findings, provider
hand-overs with checkpoint, QA repairs, retried stages), one receipt per ticket
with a bar per agent task (amber when it took more than one attempt), session
and run links, and "Where the time went" per task. Per-task data comes from
`TASK-504`.

E2E: `scheduledRuns.spec.ts` test 769 asserts `schedule-report-status` and
`schedule-report-table`. Update it in the same change as the report (keep
both ids if their meaning survives), and inspect the report screenshot.
`TASK-509` re-runs the whole suite.

## Description


## Dependencies


## Comments

## Delivery status (2026-10-24)

The initial report derives totals, per-ticket outcomes, reported spend, timings, skip reasons and handovers from the run ledger. Electron coverage verifies the stopped-run report and rows. Remaining acceptance work: provide direct ticket-session navigation (the current report only has Open run), and complete the goal's artifact, approval and per-stage timing detail. Keep the task open rather than treating the initial report as fully delivered.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).

## Delivery status (2026-11-02)

Rebuilt in the FX-BE-193 design: needed you (pauses and approvals with how long each waited), worth knowing (loops with findings, attempts, hand-overs, retries, skips), the ticket table with an agent-task bar column whose bars open each stage's session, where the time went, and the ledger behind a disclosure. Reachable as "Report so far" while the run is going. Test 769's report assertions pass unchanged.
