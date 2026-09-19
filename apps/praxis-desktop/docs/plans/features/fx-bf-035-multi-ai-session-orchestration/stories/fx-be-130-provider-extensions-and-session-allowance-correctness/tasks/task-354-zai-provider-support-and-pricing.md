---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Task
**Priority:** High
type: Task
id: TASK-354
title: "Add Z.ai provider support and pricing-aware usage estimates"
status: Complete
story: FX-BE-130
feature: FX-BF-035
updated: 2026-09-20
dependencies: [FX-BE-093, FX-BF-041]
---

# TASK-354: Add Z.ai provider support and pricing-aware usage estimates

## Objective

Make Z.ai usable anywhere an OpenAI-compatible API provider is supported and
populate the existing token/cost usage surfaces for its published GLM models.

## Completed work

- Added Z.ai provider metadata, secure key storage, model defaults, model
  discovery, auth probing, review/recommendation routing, and `/api/paas/v4`
  path handling.
- Added a maintained Z.ai model pricing table and cost accumulation from
  per-response token usage.
- Preserved an explicit unavailable state for account balance, quota, and
  provider billing data not exposed by the integration.

## Verification

Core provider/pricing tests, full core test suite, renderer/main typechecks,
renderer build, and `git diff --check` passed. **Complete.**

## Description


## Dependencies



## Comments


