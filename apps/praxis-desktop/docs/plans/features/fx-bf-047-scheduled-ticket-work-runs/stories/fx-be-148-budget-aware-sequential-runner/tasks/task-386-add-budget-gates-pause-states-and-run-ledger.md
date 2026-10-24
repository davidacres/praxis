---
**Status:** 🔄 In Progress
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-386
title: Add budget gates, pause states, and run ledger
status: In Progress
story: FX-BE-148
updated: 2026-10-24
dependencies: [TASK-385, FX-BF-041]
validation: [npm run test:core, npm run test:desktop]
---

# Add budget gates, pause states, and run ledger

## Goal

Protect scheduled runs from silently exhausting allowance and give users a clear
ledger of spend, pauses, retries, skips, and outcomes.

## Done when

- The runner checks the enabled providers' remaining allowance before each
  queue entry starts. There is no per-run dollar cap in the initial release.
- A schedule can pause for budget, approval, policy, trust, missing provider,
  or user decision.
- The ledger records queue-entry transitions, spend estimates, actual spend,
  session links, artifacts, and retry or skip decisions.

## Notes

Budget checks should be conservative. It is better to pause before starting the
next ticket than to begin work that is unlikely to finish.

## Description


## Dependencies



## Comments

## Delivery status (2026-10-24)

Budget checks, pause reasons, entry transitions, retries/skips, workflow/session identifiers and reported spend are implemented and tested. Remaining acceptance work: make spend estimates and artifact references part of the durable run ledger; the current `ScheduledEntryOutcome` stores spend, links and handovers but no artifact collection, and `spendFor` aggregates reported usage rather than persisting the requested estimates. Do not mark the full ledger requirement complete yet.

Implementation and verification evidence are recorded in the parent feature's Delivery status section (`FX-BF-047`, merge `f297b332`).
