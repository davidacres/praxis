---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-418
slug: derive-budget-status-from-reason-code
title: Derive Budget Card Status from the Reason Code
status: Done
created: 2026-10-04
owner: Electron desktop app
featureId: 107
storyId: 157
---

# TASK-418: Derive Budget Card Status from the Reason Code

## Description

Replace the "any reason means offline" ternary with a switch on the structured code, in both renderers, and give the "no data" state a distinct presentation so it is no longer visually identical to a failure.

## Acceptance criteria

- `ProviderBudgetsPanel.tsx` and `AiUsageStatsSection.tsx` both map the code to a label: `not-configured` to Setup, `not-supported` to No data, `cli-unavailable` to Not on PATH, `fetch-failed` to Offline.
- No code path derives status from the message text.
- An `is-nodata` class is styled in `theme.css` so a permanently unsupported provider is not greyed like a current outage.
- Label wording matches the existing settings page, which already renders Setup and Not on PATH for the same concepts.
- The active and warn states are unchanged.

## Verification

- `check-types` clean across all five workspaces.
- Playwright asserts an unsupported provider is never badged Offline, and that a card showing a percentage carries a warning or active badge rather than a data state.

## Dependencies

- TASK-417

## Comments


