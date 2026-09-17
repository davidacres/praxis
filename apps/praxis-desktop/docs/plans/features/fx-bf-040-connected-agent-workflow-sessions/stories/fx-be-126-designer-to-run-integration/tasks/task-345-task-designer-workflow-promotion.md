---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.731Z
**Type:** Task
**Priority:** Medium
id: TASK-345
title: Add explicit Task Designer plan-to-workflow input and promotion flow
status: Planned
story: FX-BE-126
updated: 2026-09-17
dependencies: [TASK-335, TASK-344]
validation: [npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Add explicit Task Designer plan-to-workflow input and promotion flow

## Goal

Let a task plan contribute inputs to a governed workflow without pretending
that a planning canvas is itself an executable graph.

## Done when

- The user can explicitly use a selected plan/master-plan artifact as workflow
  input or promote it through a documented mapping step.
- The original plan remains intact and the run records its artifact identity,
  revision, and mapping summary.
- The operation reuses normal workflow readiness, policy, and start gates.

## Notes

Do not infer agent assignments or approval policy from arbitrary canvas nodes
without showing the mapping and requiring confirmation.

## Description


## Dependencies



## Comments
