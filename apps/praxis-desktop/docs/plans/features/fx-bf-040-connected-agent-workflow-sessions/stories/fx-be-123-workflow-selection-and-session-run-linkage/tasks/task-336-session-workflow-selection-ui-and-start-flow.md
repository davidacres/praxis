---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.727Z
**Type:** Task
**Priority:** Medium
id: TASK-336
title: Add session composer workflow selection, readiness, and start flow
status: Planned
story: FX-BE-123
updated: 2026-09-17
dependencies: [TASK-335]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Add session composer workflow selection, readiness, and start flow

## Goal

Expose governed workflows in New Session and ticket Start AI, using the same
readiness/effective-policy response that the run start handler enforces.

## Done when

- The composer lists scoped definitions/templates, explains readiness blockers,
  and makes the no-workflow path explicit.
- Start sends workflow identity plus binding/task inputs through typed IPC and
  cannot bypass server-side validation.
- Loading, empty, invalid, policy-blocked, and unavailable-host states are
  covered with accessible in-app UI.

## Notes

Do not present a workflow pack as a governed workflow. The picker label and
details must identify whether the selection is a definition or a template.

## Description


## Dependencies



## Comments
