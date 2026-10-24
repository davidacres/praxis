---
**Status:** 🔄 In Progress
**Created:** 2026-10-20T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-466
title: Build the run report
status: In Progress
story: FX-BE-173
updated: 2026-10-24
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

## Description


## Dependencies


## Comments

## Delivery status (2026-10-24)

The initial report derives totals, per-ticket outcomes, reported spend, timings, skip reasons and handovers from the run ledger. Electron coverage verifies the stopped-run report and rows. Remaining acceptance work: provide direct ticket-session navigation (the current report only has Open run), and complete the goal's artifact, approval and per-stage timing detail. Keep the task open rather than treating the initial report as fully delivered.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
