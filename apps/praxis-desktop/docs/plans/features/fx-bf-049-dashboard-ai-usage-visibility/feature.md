---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-049
slug: dashboard-ai-usage-visibility
title: Dashboard AI usage visibility
status: Backlog
created: 2026-10-03
owner: Electron desktop app
---

# FX-BF-049: Dashboard AI usage visibility

## Outcome

The Overview dashboard carries a full-width AI usage panel: four period tiles
(today, this week, this month, all time) showing tokens and cost, a peak figure
per period, and a ranked top-models list with per-model cost. It is a summary
of the existing Settings → AI Usage page, not a second answer that can disagree
with it.

## Why

Usage is currently only visible in Settings, one level into a dialog, and only
across one granular window at a time. The two questions a person actually has —
"what am I burning per week, and on which model" — have no single answer on the
page they land on. Settings → AI → Spend is not a substitute: it reads
`AgentSessionRecord`s, so it misses internal one-shot AI calls, and its totals
will legitimately differ from the ledger.

## Scope

- A core aggregation that produces a model breakdown (tokens, share, event count,
  cost per currency), an all-time total, and busiest day/week/month in a single
  pass over the durable usage ledger.
- One read-only IPC read that returns the whole dashboard payload.
- A new full-width panel on the Overview page, placed between the "Start here"
  strip and the Active AI sessions / Recent conversations / Recent projects row.
- The same model breakdown added to the Settings AI Usage page, so the dashboard
  is a summary of that page.
- Explicit handling of absent cost: ACP CLI agents (Claude Code, Codex) report
  cost; API-key providers do not. "Not reported" is shown, never `$0.00`.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-151 | Dashboard AI usage panel with period totals and top models | Backlog | FX-BF-041, FX-BF-015 |

## Delivery order

1. Core aggregation (model breakdown, all-time, highs, one pass).
2. Single read-only IPC summary.
3. Overview panel.
4. Settings page parity.
5. Verification and documentation.

## Key decisions

- **Per-model cost requires a core change.** `UsageBucket.byModel` currently
  carries `{ model, totalTokens }` only, and cost lives per bucket rather than
  per model. The events themselves carry both, so this is derivable — but it is
  a new core type, not a mutation of `UsageBucket`, so the existing chart and
  Settings page do not break.
- **"All time" means all time as far as the ledger goes.** The ledger is capped
  at 20,000 events, so the tile is labelled `All time (since <first event>)`
  rather than implying a lifetime total. No separate lifetime accumulator.
- **The ledger is the source of truth**, not `AgentSessionRecord`s. The panel
  carries a footnote saying totals differ from Settings → AI → Spend because
  Spend excludes internal one-shot AI calls.
- **Highs are by tokens.** "Today" is UTC, matching the existing AI Usage page
  rather than the user's local day.
- **Placement is its own full-width panel** above the three-column row, not
  inside it — four period tiles do not survive a third of the page width.
- **Panel placement:** between the "Start here" strip and the Active AI sessions
  / Recent conversations / Recent projects row. Below that row it would be
  buried under activity content; the "Start here" strip should stay highest
  while the workspace is still empty.

## Risks or open questions

- Cost is sparse by design. A workspace using only API-key providers will show
  tokens and "not reported" for cost. The panel must not read as broken.
- The 20,000-event cap means `All time` silently ages. The `since <date>` label
  is the mitigation; a lifetime accumulator is a separate decision.
- Per-period peak requires a full-ledger pass even for the "today" tile. One
  pass serving all four periods is what keeps this cheap; a per-tile call would
  rescan the log on every render.
- Multi-currency cost (`costByCurrency`) is possible in principle. The panel
  sums only when there is a single currency and otherwise labels rather than
  converting.

## Dependencies

- `FX-BF-041` — session usage and provider allowance visibility; owns the
  provider-neutral snapshot contract and the durable usage ledger.
- `FX-BF-015` — session review and cost/context presentation; owns
  `formatTokenCount` / `formatCost` conventions in `ai/sessionNav.ts`.
- Existing `packages/core/src/ai/aiUsageLog.ts` and `aiUsageStats.ts`.

## Close when

The Overview dashboard shows four period tiles with tokens, cost and a peak, a
ranked top-models list with per-model cost, and links to the full AI Usage page;
the same numbers appear in Settings → AI Usage; and an e2e test seeds a known
ledger and asserts the exact figures.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-151 | Story | Dashboard AI usage panel with period totals and top models | Backlog |
| TASK-396 | Task | Core per-model, all-time and peak usage aggregation | Backlog |
| TASK-397 | Task | Single read-only IPC summary for the dashboard | Backlog |
| TASK-398 | Task | Overview dashboard AI usage panel | Backlog |
| TASK-399 | Task | AI usage settings page model breakdown parity | Backlog |
| TASK-400 | Task | Verification, e2e proof and documentation | Backlog |

## Description


## Comments
