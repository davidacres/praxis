---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.732Z
**Type:** Task
**Priority:** Medium
id: TASK-346
title: Add cross-surface navigation and run/session provenance
status: Planned
story: FX-BE-126
updated: 2026-09-17
dependencies: [TASK-337, TASK-345]
validation: [npm run build:renderer, npm run test:desktop]
---

# Add cross-surface navigation and run/session provenance

## Goal

Make workflow definition, task, controller session, run, stage session, gate,
and evidence navigable as one product journey.

## Done when

- Workflow Designer, Task Designer, Sessions, and Run Monitor expose links
  using durable ids and preserve project/workspace scope.
- Back/forward/reopen behavior returns to the correct definition, run, node,
  or session without losing the current project.
- Empty, deleted, stale, and permission-blocked targets have clear states.

## Notes

Use the existing sidebar/shell routing idioms; do not introduce another local
navigation tree owned by a designer.

## Description


## Dependencies



## Comments
