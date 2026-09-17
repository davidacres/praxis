---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.733Z
**Type:** Task
**Priority:** Medium
id: TASK-349
title: Harden run monitor operations, recovery, retry, timeout, and audit events
status: Planned
story: FX-BE-127
updated: 2026-09-17
dependencies: [TASK-337, TASK-348]
validation: [npm run test:core, npm run test:desktop]
---

# Harden run monitor operations, recovery, retry, timeout, and audit events

## Goal

Make every run operation state-safe across live updates, app restart, timeout,
retry, cancel, and recovery.

## Done when

- Retry respects attempt limits, stage mutability, worktree snapshots, and
  fresh evidence requirements.
- Restart resumes from durable state without rerunning completed stages or
  losing pending approvals.
- Operator actions and orchestrator transitions emit redacted, queryable
  audit events surfaced in the monitor.

## Notes

A controller session may request an operation, but the main-process run store
and orchestrator remain the authority for transition validity.

## Description


## Dependencies



## Comments
