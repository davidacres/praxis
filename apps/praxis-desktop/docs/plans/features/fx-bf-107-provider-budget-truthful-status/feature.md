---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-107
slug: provider-budget-truthful-status
title: Truthful Provider Budget Status on the Dashboard
status: Done
created: 2026-10-04
owner: Electron desktop app
---

# FX-BF-107: Truthful Provider Budget Status on the Dashboard

## Description

The provider budget cards on the Overview dashboard badged every provider that had an `unavailableReason` as **Offline**, and printed hardcoded spend, rate limit, tier and reset figures for providers that had never reported any data. Both behaviours presented unmeasured or invented values as if they were real measurements. This feature makes the unavailable state honest by deriving status from a structured reason code, and removes every fabricated figure from both the dashboard and the settings page.

## Outcome

- A provider is badged **Offline** only when a read was actually attempted and genuinely failed.
- A provider that needs setup, or that will never expose an account usage API, is labelled accurately instead of being reported as offline.
- A card never displays a spend, rate limit, tier or reset figure that no provider reported.
- Unmeasured cost is stated as "Not reported" rather than rendered as a dollar amount.
- The status vocabulary matches the existing settings page, so the app speaks one language.

## Scope

- `ProviderUsageUnavailableCode` in `packages/core/src/ai/providerUsage.ts`, mirroring `MobileProviderUnavailableReason`.
- Reason-code tagging across the OpenAI, Codex, Claude Code and MiniMax adapters in `apps/praxis-desktop/main/src/main/aiUsageIpc.ts`, `claudeUsage.ts`, `codexUsage.ts` and `minimaxUsage.ts`.
- Normalisation in `apps/praxis-desktop/main/src/main/providerUsageBatch.ts` so every snapshot carries a code.
- Status derivation in `apps/praxis-desktop/renderer/src/ai/ProviderBudgetsPanel.tsx` and `apps/praxis-desktop/renderer/src/settings/AiUsageStatsSection.tsx`.
- Removal of `BASELINE_FALLBACKS` and `DEFAULT_FLEET_BASELINES`, the two hardcoded tables of invented figures.
- `notice` field on the Claude Code snapshot so a session-limit message is no longer reported as unavailability.
- `is-nodata` presentation in `apps/praxis-desktop/renderer/src/styles/theme.css`.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-157 | Truthful provider budget status and removal of fabricated figures | Done | FX-BF-049 |

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-157 | Story | Truthful provider budget status and removal of fabricated figures | Done |
| TASK-417 | Task | Structured provider unavailable codes in core and adapters | Done |
| TASK-418 | Task | Derive budget card status from the reason code | Done |
| TASK-419 | Task | Remove fabricated provider figures and verify end to end | Done |

## Comments

### 2026-10-04 - Implementation & Verification Complete
- **Author:** Praxis
- **Status:** Complete.
- **Root cause:** `snapshot.unavailableReason ? 'offline' : …` treated the presence of any human-readable reason as proof of a failed read. The field carried three unrelated meanings, so a provider missing an optional key, a provider that will never support the API, and a genuine fetch failure all collapsed into one grey "Offline" badge. The same ternary appeared at `AiUsageStatsSection.tsx:515` and `:572`, so the settings page was wrong in two places as well.
- **Worse finding:** `BASELINE_FALLBACKS` and `DEFAULT_FLEET_BASELINES` held hardcoded values rendered alongside real readings — OpenAI `$2.15`, Anthropic `$3.80`, Codex "43% used, resets in 2h 14m", plus invented `"Tier 2 • 300 RPM"` pills. A provider with no data therefore displayed fabricated spend and rate limits. Both tables were deleted.
- **Contradiction fixed:** `claudeUsage.ts` placed a "session limit reached" message in `unavailableReason` while also returning a 100% window, so one card could show a full bar and claim to be offline at once. A dedicated `notice` field now carries that message.
- **Test-found gap:** the batch layer passed adapter results through without defaulting the code, so a prose-only snapshot would still have rendered as "has a reason". A new unit test caught this and the source was normalised rather than the assertion relaxed.
- **Verification:**
  - `npm run test:core`: 1,388 tests passed.
  - `npm run test:desktop`: 10 tests passed in `providerUsageBatch.test.ts`.
  - `npm run check-types`: Clean across all five workspaces.
  - `npm run build`: Succeeded.
  - Playwright `e2e/overviewProviderBudgets.spec.ts`: 7 tests passed, including two new ones asserting a `not-supported` provider is never badged Offline and that no card contains an invented spend, RPM, tier or dollar figure.
- **Build note:** the e2e harness loads `apps/praxis-desktop/main/renderer`, a copy of the renderer build, not `renderer/dist`. `npm run desktop:copy-renderer` must run after any renderer change or the suite tests a stale bundle.

## Dependencies

- FX-BF-049 (Dashboard AI usage visibility) — introduced the budget panel and the copied ternary.
- FX-BF-041 (Session usage and provider allowance visibility) — established `ProviderUsageSnapshot`.
- `packages/core/src/ai/mobileHostComposition.ts` — existing structured-reason convention this mirrors.
