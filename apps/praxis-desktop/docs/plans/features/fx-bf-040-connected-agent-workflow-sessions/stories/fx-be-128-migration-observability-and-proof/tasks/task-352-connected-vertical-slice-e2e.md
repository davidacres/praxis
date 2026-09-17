---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.734Z
**Type:** Task
**Priority:** Medium
id: TASK-352
title: Add deterministic fixtures, real-host vertical E2E, and final verification
status: Planned
story: FX-BE-128
updated: 2026-09-17
dependencies: [TASK-340, TASK-342, TASK-345, TASK-348, TASK-350, TASK-351]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# Add deterministic fixtures, real-host vertical E2E, and final verification

## Goal

Prove the product promise from session selection through host execution,
workflow scheduling, skill/pack context, evidence, gates, approval, and
reopen-after-restart.

## Done when

- Deterministic fixtures cover no-workflow, invalid graph, unavailable host,
  blocked gate, approval, bypass, retry, timeout, and multiple approvals.
- One local real-host fixture proves the declared Agent Hub command/transport
  handled a normal session and a governed stage.
- Full validation passes and the implementation report distinguishes code
  coverage from visual/live proof.

## Notes

Run the focused tests first, review the diff, then run the full desktop/core
validation and a disposable manual smoke journey. Preserve only useful visual
evidence if it materially helps judge the connected flow.

## Description


## Dependencies



## Comments
