---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Task
**Priority:** High
type: Task
id: TASK-356
title: "Clear stale runtime limit state and hide unconfigured providers"
status: Complete
story: FX-BE-130
feature: FX-BF-035
updated: 2026-09-20
dependencies: [FX-BE-115, TASK-354]
---

# TASK-356: Clear stale runtime limit state and hide unconfigured providers

## Objective

Keep the session Usage panel and provider-selection controls aligned with the
currently selected runtime.

## Completed work

- Clear `providerLimitReached` and `lastError` when a provider/model runtime
  transition occurs, with regression coverage for handover and model change.
- Filter unconfigured providers from handover and second-AI pickers while
  retaining the active provider when necessary for truthful session display.

## Verification

Core regression tests, renderer typecheck/build, and the related desktop suites
passed. **Complete.**

## Description


## Dependencies



## Comments


