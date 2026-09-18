---
**Status:** 📋 Proposed
**Created:** 2026-09-18T09:58:20.274Z
**Type:** Task
**Priority:** Medium
id: TASK-353
title: Implement and verify session usage and provider allowance visibility
status: Complete
story: FX-BE-129
feature: FX-BF-041
updated: 2026-09-18
---

# TASK-353: Implement and verify session usage and provider allowance visibility

## Outcome

The Praxis Desktop session panel presents local and provider-reported AI usage
in a provider-neutral, secure, and actionable way.

## Completed work

- Added `ProviderUsageSnapshot`, usage windows, optional credits, and model-cost
  fields to the shared core contract.
- Added an adapter registry and OpenAI Admin usage/cost adapter in the Electron
  main process.
- Added encrypted Usage Admin API key storage and typed preload IPC.
- Added hourly usage aggregation alongside day/week/month aggregation.
- Added the session composer Usage disclosure with session totals, recent
  windows, model rows, account state, and warning banners.
- Added the OpenAI Usage Admin key field to AI Provider settings.

## Completion evidence

- Core, renderer, and main-process typechecks pass.
- Renderer production build passes.
- Focused `aiUsageStats` tests pass, including the hourly bucket test.
- Renderer core-import check and `git diff --check` pass.

## Boundary notes

Provider balances, rate limits, and model pricing remain optional adapter data.
When a provider does not expose them, the UI says so explicitly; it does not
turn token totals into an invented credit balance.

## Description


## Dependencies



## Comments
