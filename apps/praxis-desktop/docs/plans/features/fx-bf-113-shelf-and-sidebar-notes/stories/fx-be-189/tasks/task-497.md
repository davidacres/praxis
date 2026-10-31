---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.663Z
**Type:** Task
**Priority:** Medium
id: TASK-497
type: Task
status: To Do
---

# TASK-497: Implement notes persistence and typed IPC

## Work and acceptance

Use existing app-local store patterns and main/preload IPC conventions. Implement CRUD, membership operations, atomic saves, change notifications and restart restoration. Group removal preserves notes; note deletion cleans memberships. Reject cross-project access. Test round trips, failed writes, group integrity and existing-data startup.

## Boundary

Follow FX-BF-113. Scheduled runs remain excluded. Preserve unrelated workspace changes.

## Dependencies

TASK-496

## Description


## Comments
