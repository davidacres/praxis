---
**Status:** ✅ Complete
**Created:** 2026-09-18T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-129
title: "Session usage, cost, and provider allowance visibility"
status: Complete
feature: FX-BF-041
issue: docs/issues/features/fx-bf-041-session-usage-and-provider-allowance-visibility/stories/fx-be-129-session-usage-cost-and-provider-allowance-visibility/issue.md
updated: 2026-09-18
tasks: [TASK-353]
dependencies: [FX-BF-015, FX-BF-035]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer, node --test packages/core/out/ai/aiUsageStats.test.js]
---

# FX-BE-129: Session usage, cost, and provider allowance visibility

## User or operational impact

Users can see what the selected AI session consumed and whether the current
Praxis budget or a provider-reported allowance is approaching its threshold,
without opening a separate dashboard or mistaking context occupancy for spend.

## Scope

- Add the expandable usage summary to the session composer.
- Include current-session usage, recent hourly/day/week/month totals, and model
  rows using the existing durable ledger and session records.
- Keep warnings informational: Praxis reports pressure but does not silently
  stop an agent.
- Add the provider-neutral snapshot shape and main-process adapter registry.
- Implement OpenAI Admin completion usage and best-effort organization costs.
- Store the optional OpenAI Usage Admin key through the existing encrypted
  secrets boundary.

## Acceptance criteria

- A selected session has a visible Usage disclosure in the composer.
- Expanded usage shows session tokens/cost, hourly/day/week/month totals, and
  model-attributed totals where data exists.
- The UI warns at 80% and 100% of the configured Praxis spend limit and uses
  explicit unavailable states for missing provider data.
- OpenAI account usage is fetched only in the main process and never exposes an
  Admin API key to the renderer.
- New provider support can register an adapter without changing the renderer's
  `ProviderUsageSnapshot` contract.
- Existing session, usage-ledger, and renderer builds remain type-safe.

## Task list

- `TASK-353` — Implement and verify session usage and provider allowance visibility.

## Validation

- `npm run check-types --workspace=@praxis/core`
- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run check-types --workspace=@praxis/desktop-main`
- `npm run build --workspace=@praxis/desktop-renderer`
- `node --test packages/core/out/ai/aiUsageStats.test.js`
- `git diff --check`

## Close when

The selected session reports local usage and threshold warnings, OpenAI usage
can be connected securely when an Admin key is available, and unsupported
provider allowance fields remain honest and extensible rather than guessed.

## Description


## Dependencies



## Comments
