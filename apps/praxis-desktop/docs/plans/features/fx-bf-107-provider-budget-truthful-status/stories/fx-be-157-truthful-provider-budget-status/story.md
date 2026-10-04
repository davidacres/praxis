---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-157
slug: truthful-provider-budget-status
title: Truthful Provider Budget Status and Removal of Fabricated Figures
status: Done
created: 2026-10-04
owner: Electron desktop app
featureId: 107
---

# FX-BE-157: Truthful Provider Budget Status and Removal of Fabricated Figures

## Description

Provider budget cards must never imply a measurement that no provider reported. This story replaces the "any reason means offline" heuristic with a structured reason code, and removes the hardcoded baseline tables that printed invented spend, rate limits and reset countdowns next to genuine readings.

## Acceptance criteria

- `ProviderUsageSnapshot` carries a machine-readable `unavailableReasonCode` alongside the existing display string.
- Each adapter tags its true category: missing credential, unsupported provider, missing CLI, failed fetch.
- A card is badged Offline only for a genuinely failed read.
- A provider that has never been configured is badged Setup and shows the action required.
- A provider that cannot ever expose usage is badged No data.
- No card renders a spend, rate limit, tier or reset figure that was not reported by the provider.
- Unmeasured cost reads "Not reported".
- A Claude Code session-limit message is displayed as a notice and never as an unavailability reason.
- Unit tests pin each reason code, and e2e tests pin both the label and the absence of invented figures.

## Tasks

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| TASK-417 | Task | Structured provider unavailable codes in core and adapters | Done |
| TASK-418 | Task | Derive budget card status from the reason code | Done |
| TASK-419 | Task | Remove fabricated provider figures and verify end to end | Done |

## Dependencies

- FX-BF-107
- FX-BF-049
- TASK-396, TASK-397, TASK-398 (FX-BF-049 dashboard AI usage panel)

## Comments


