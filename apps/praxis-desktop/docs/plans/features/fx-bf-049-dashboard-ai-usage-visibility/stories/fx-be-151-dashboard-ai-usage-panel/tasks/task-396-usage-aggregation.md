---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-396
type: Task
status: Done
created: 2026-10-03
priority: High
---

# Add per-model, all-time and peak usage aggregation to core

## Files and integration points

`packages/core/src/ai/aiUsageStats.ts` (new exported types and one summary
function) and `packages/core/src/ai/aiUsageStats.test.ts`. No change to
`aiUsageLog.ts`, so there is no migration and no new on-disk data.

## Scope

Add three new exported types and one function that returns the whole dashboard
payload in a single pass over the ledger:

- A model breakdown carrying `model`, `provider`, `totalTokens`, `tokenShare`,
  `eventCount` and `costByCurrency` per model, over a given window or the whole
  ledger.
- An all-time summary: `tokens`, `costByCurrency`, `eventCount`, `firstEventAt`,
  `lastEventAt`.
- Period highs: busiest day, busiest week and busiest month, by tokens.

`UsageBucket.byModel` stays exactly as it is — `{ model, totalTokens }` — so the
existing chart and the Settings AI Usage page are untouched. The breakdown is a
new type, not a mutation. Read the existing `usageSeries` period bucketing and
reuse its UTC boundaries and Monday week start rather than re-deriving them, so
the two cannot disagree about what "this week" means.

Cost is summed from the per-event `cost` field, which carries currency, so
aggregate as a map keyed by currency. A model with no reported cost has an empty
map, which is how the UI tells "not reported" from "$0.00".

The single-pass requirement is load-bearing: the panel needs four periods plus
all-time plus highs, and a per-window call each time would rescan up to 20,000
events on every render. One pass, accumulating every period's bucket at once.

## Dependencies

TASK-396 has no upstream task. It depends on the existing
`packages/core/src/ai/aiUsageLog.ts` event shape and `aiUsageStats.ts` period
conventions.

## Done conditions and validation

Unit tests in `aiUsageStats.test.ts` (already in `npm run test:core`) cover: a
model breakdown that sums per model and across models; per-model cost attributed
to the right model with mixed reporting providers; a model with no cost
distinguishable from zero cost; all-time totals including `firstEventAt`; highs
across day, week and month with correct boundary handling; multi-currency cost
kept separate; an empty ledger; and a tie between two equally busy periods
resolving deterministically. Assert the single-pass function's output equals the
existing per-window functions' totals, so the two implementations are proven
consistent.

## Description


## Comments

**2026-10-10:** Closed during backlog review: the Overview AI usage panel, core aggregation (aiUsageStats), IPC summary, Settings model breakdown (UsageModelBreakdown) and e2e coverage (overviewAiUsage.spec.ts, aiUsageDashboardRedesign.spec.ts) are all in the tree.
