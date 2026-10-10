---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-397
type: Task
status: Done
created: 2026-10-03
priority: High
---

# Expose one read-only IPC summary for the dashboard panel

## Files and integration points

`packages/core/src/ai/aiUsageIpc.ts` (add the channel to the `AiUsageIpc`
contract), `apps/praxis-desktop/main/src/main/aiUsageIpc.ts` (register the
handler), and the main preload exposure of `window.praxis.aiUsage`. Follow the
existing `series` / `compareLatestPeriod` / `listEvents` handlers in the same
file rather than introducing a new IPC surface.

## Scope

Add a single `aiUsage:dashboardSummary` read that returns the payload built in
TASK-396: four period summaries, the all-time summary, highs, and the ranked
model breakdown. One channel rather than five, so the panel is one await and one
payload.

This is a read. Do not add a renderer write path, and do not add a settings
field or keychain entry — the existing provider key and spend-limit settings are
unrelated to this read and stay where they are.

Memoise the computed summary, keyed on the ledger's event count plus the last
event's id or timestamp. Without that, every re-render of the Overview page
rescans the whole ledger, and the panel is on the page people land on. Invalidate
when an event is appended.

## Dependencies

TASK-396

## Done conditions and validation

`npm run check-types` passes for core, main and renderer. The handler returns the
same figures as TASK-396's function when called directly. Repeated reads with an
unchanged ledger are served from the memo, and a newly appended event
invalidates it. The renderer receives types only from core — no value import,
which `npm run check-core-imports` enforces during the renderer build.

## Description


## Comments

**2026-10-10:** Closed during backlog review: the Overview AI usage panel, core aggregation (aiUsageStats), IPC summary, Settings model breakdown (UsageModelBreakdown) and e2e coverage (overviewAiUsage.spec.ts, aiUsageDashboardRedesign.spec.ts) are all in the tree.
