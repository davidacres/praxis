---
**Status:** 📋 Proposed
**Created:** 2026-09-29T00:00:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-385
title: Implement scheduled sequential execution
status: Backlog
story: FX-BE-148
updated: 2026-09-29
dependencies: [TASK-383, TASK-384]
validation: [npm run test:core, npm run test:desktop]
---

# Implement scheduled sequential execution

## Goal

Run due schedules through a deterministic sequential queue where only one ticket
entry is active by default.

## Done when

- Due schedules are discovered after app start and resume without duplicate
  launches.
- The runner starts the first ready queue entry and waits for a terminal,
  paused, or skipped state before considering the next entry.
- Restart recovery resumes or reconciles active schedule attempts without losing
  queue order.

## Notes

Use the existing session and governed workflow execution paths. The scheduler
should coordinate work, not become a separate automation runtime.

