---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-436
slug: projected-cost-in-start-dialog
title: Projected worst-case cost in the start-run dialog
status: Done
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 167
---

# TASK-436: Projected worst-case cost in the start-run dialog

## Description

Add a core estimator and surface it in `StartRunDialog.tsx`: maximum stage launches (loop budgets and map caps), the models and tiers they would use, and a token/spend range only where per-model usage data exists.

## Acceptance criteria

- The estimator is pure core code with tests over loops, nested loops and maps; the renderer imports types only.
- Where there is no usage data the dialog says "not estimable"; it never shows an invented figure.
- A run whose worst-case launches exceed a configurable threshold requires an explicit confirm.
- The figures are labelled as an estimate and the worst case is never described as expected cost.

## Dependencies

- TASK-431
- TASK-429

## Comments
