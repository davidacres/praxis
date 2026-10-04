---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-419
slug: remove-fabricated-provider-figures
title: Remove Fabricated Provider Figures and Verify End to End
status: Done
created: 2026-10-04
owner: Electron desktop app
featureId: 107
storyId: 157
---

# TASK-419: Remove Fabricated Provider Figures and Verify End to End

## Description

The two hardcoded baseline tables rendered invented spend, rate limit, tier and reset values in the same position as genuine readings, so a provider with no data appeared to have been measured. Delete both, make unmeasured cost explicit, and verify end to end.

## Acceptance criteria

- `BASELINE_FALLBACKS` in `ProviderBudgetsPanel.tsx` is removed.
- `DEFAULT_FLEET_BASELINES` in `AiUsageStatsSection.tsx` is removed.
- The card footer no longer renders unconditionally; it is suppressed when there is no measured data.
- Unmeasured spend reads "Not reported" rather than a formatted currency amount.
- A rate-limit pill is rendered only when the provider actually reported one.
- An e2e test asserts no budget card contains an invented spend, RPM, tier or dollar figure.

## Scope of the defect

OpenAI `$2.15`, Anthropic `$3.80`, Codex "43% used, resets in 2h 14m", and invented "Tier 2 • 300 RPM" pills. These were presented as measurement. This is more serious than the incorrect Offline label, because a wrong label misleads while a fabricated figure can be acted upon.

## Verification

- `npm run test:core`: 1,388 tests passed.
- `npm run test:desktop`: 10 tests passed.
- `npm run check-types`: clean across all five workspaces.
- `npm run build`: succeeded.
- `e2e/overviewProviderBudgets.spec.ts`: 7 tests passed, including the new absence-of-fabricated-figures assertion.
- Visual confirmation: every provider card reads Active or No data, with no invented figures.

## Dependencies

- TASK-418

## Comments


