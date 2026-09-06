---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-039
title: Cost and token spend report
status: complete
feature: FX-BF-017
issue: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/stories/fx-be-039-spend-report/issue.md
updated: 2026-09-06
commits: [7ceb086]
dependencies: [FX-BF-015]
validation: [npm run check-types, npm run test:desktop]
---

# Cost and token spend report

## User or operational impact

Per-session cost and tokens existed, but the only place a *total* ever appeared
was the composer's spend-limit banner — and only once within a third of the
limit. "What has this cost so far" had no answer short of reading every session
by hand.

## As built (`7ceb086`)

- Three new pure functions in `sessionNav.ts` — `summariseSpendByProviderModel`,
  `summariseSpendByConnection`, `sessionsWithinDays` — all built **on top of**
  the existing `summariseSpend` rather than reimplementing its currency-safety
  rules.
- A report block in Settings → AI Provider under the spend-limit field: total
  cost by currency, a provider/model breakdown, a connection breakdown, and an
  All time / 30 days / 7 days filter.
- Self-contained like the section's existing `listProviderStatuses` call —
  fetches `listSessions` and stays live via `onSessionChanged` /
  `onSessionDeleted` rather than growing App's prop surface.

## The invariant this story exists to protect

A group's row shows **cost per currency it actually reported**, and tokens only
if a session in it reported those. Never one blended figure across currencies,
and never a token count turned into an invented cost.

## Acceptance criteria — verified

- Per-currency rows; no blending; no invented costs.
- The report updates live as sessions complete, without reopening Settings.
- A range with no sessions shows an explicit empty state, not a blank report.

## Tests

`aiSpendReport.spec.ts` (e2e), with captures
`output/playwright/ai-spend-report.png` and `spend-limit-warn.png`.

## Description


## Dependencies



## Comments


