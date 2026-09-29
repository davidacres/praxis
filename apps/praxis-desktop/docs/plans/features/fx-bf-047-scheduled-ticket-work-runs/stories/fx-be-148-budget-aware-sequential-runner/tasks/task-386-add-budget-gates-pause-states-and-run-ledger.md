---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-386
title: Add budget gates, pause states, and run ledger
status: Backlog
story: FX-BE-148
updated: 2026-09-29
dependencies: [TASK-385, FX-BF-041]
validation: [npm run test:core, npm run test:desktop]
---

# Add budget gates, pause states, and run ledger

## Goal

Protect scheduled runs from silently exhausting allowance and give users a clear
ledger of spend, pauses, retries, skips, and outcomes.

## Done when

- The runner checks remaining run budget and provider allowance before each
  queue entry starts.
- A schedule can pause for budget, approval, policy, trust, missing provider,
  or user decision.
- The ledger records queue-entry transitions, spend estimates, actual spend,
  session links, artifacts, and retry or skip decisions.

## Notes

Budget checks should be conservative. It is better to pause before starting the
next ticket than to begin work that is unlikely to finish.

