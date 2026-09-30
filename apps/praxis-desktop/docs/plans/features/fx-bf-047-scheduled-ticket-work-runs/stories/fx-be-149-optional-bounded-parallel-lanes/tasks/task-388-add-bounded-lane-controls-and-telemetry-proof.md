---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-388
title: Add bounded lane controls and telemetry proof
status: Backlog
story: FX-BE-149
updated: 2026-09-29
dependencies: [TASK-387]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# Add bounded lane controls and telemetry proof

## Goal

Add the UI and evidence needed for users to enable, monitor, and trust bounded
parallel scheduled work.

## Done when

- The schedule editor exposes parallel lanes only as an advanced explicit
  option with max-concurrency and budget warning controls.
- The run view shows active lanes, queued work, blocked entries, pause reasons,
  and actual spend while the run is active.
- E2E evidence proves the UI prevents unsafe parallel starts and records lane
  assignment in the run ledger.

## Notes

Use parallel mode sparingly in copy and defaults. The product should nudge users
toward completion, not maximum simultaneous spend.

## Description


## Dependencies



## Comments


