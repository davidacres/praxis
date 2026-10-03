---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Story
**Priority:** Medium
id: FX-BE-151
type: Story
status: Backlog
created: 2026-10-03
owner: Electron desktop app
---

# Dashboard AI usage panel with period totals and top models

## Impact

A person opening Praxis sees AI consumption without opening Settings: what was
spent today, this week, this month and in total, the peak in each window, and
which models are responsible. The answer is the same one Settings → AI Usage
gives, at a glance.

## Scope

Core usage aggregation for per-model cost, all-time totals and period peaks; a
single read-only IPC summary; a new full-width panel on the Overview dashboard;
and the same model breakdown on the Settings AI Usage page so the two cannot
drift. No new data is written to disk and no existing usage contract is changed.

### Panel design

The panel is full width, placed between the "Start here" strip and the Active AI
sessions / Recent conversations / Recent projects row. Four period tiles —
today, this week, this month, all time — each showing tokens, cost, and one peak
line ("peak 240k · Tue"). Below them, a "Top models" list: rank, model name,
token share bar, tokens, token share percentage, and per-model cost.

The period tiles reuse the existing stat-tile visual language rather than
inventing a second one. All four are read-only aggregates; there is no period
switch on the tiles themselves. The only control is a period selector on the Top
models list, so the panel stays a summary and the Settings page stays the place
to explore. A "View details" action opens Settings → AI Usage.

Three states: empty workspace (a call to start a conversation), usage present
with no cost reported, and normal.

## Acceptance criteria

- Per-model cost is available. `UsageBucket.byModel` is left unchanged so the
  existing chart and Settings page do not break; the breakdown is a new core
  type carrying model, provider, tokens, token share, event count and cost per
  currency.
- All-time totals are available and honestly labelled `All time (since <first
  event date>)`, because the ledger is capped at 20,000 events.
- Busiest day, week and month are computed by tokens, on UTC boundaries, with
  weeks starting Monday — matching the existing `usageSeries` conventions.
- The whole payload is produced by one function in one pass over the ledger. The
  panel does not issue four or five separate series reads per render.
- Cost that a provider does not report is shown as "not reported", never
  `$0.00`, and the panel states that cost comes from ACP agents only.
- When a period's cost spans several currencies, the panel labels rather than
  converting.
- The four period tiles and the top-models list show identical figures to the
  Settings AI Usage page, because both read the same aggregation.
- The dashboard total is footnoted as differing from Settings → AI → Spend,
  which excludes internal one-shot AI calls.
- Styling adds `.overview-usage-*` rules to the existing overview section of
  `theme.css` using theme tokens only, with no hard-coded colours, so all theme
  axes pick it up.
- The panel is a summary: the only interactive control is the top-models period
  selector and the "View details" link.
- The panel is full width and does not change the layout of any existing
  Overview panel below it.

## Dependencies

FX-BF-049. `FX-BF-041` (usage ledger and provider-neutral snapshot), `FX-BF-015`
(`formatTokenCount` / `formatCost` in `ai/sessionNav.ts`). Renderer area notes in
`renderer/AGENTS.md` govern the panel and its theming.

## Tasks

- [TASK-396: Core per-model, all-time and peak usage aggregation](tasks/task-396-usage-aggregation.md)
- [TASK-397: Single read-only IPC summary for the dashboard](tasks/task-397-usage-ipc-summary.md)
- [TASK-398: Overview dashboard AI usage panel](tasks/task-398-usage-dashboard-panel.md)
- [TASK-399: AI usage settings page model breakdown parity](tasks/task-399-usage-settings-parity.md)
- [TASK-400: Verification, e2e proof and documentation](tasks/task-400-usage-verification.md)

## Validation

`node --test` on core `aiUsageStats.test.ts`; `npm run check-types` across
workspaces; `npm run build` for the renderer, which runs the core-import check;
full `npm run test:desktop` after `desktop:copy-renderer`; and visual
inspection of the running app with a seeded ledger. Update the usage row in
`docs/desktop-feature-parity.md`.

## Close conditions

Acceptance criteria pass, the panel renders correctly in all four theme axes,
the e2e test asserts exact figures from a seeded ledger, and the Settings page
and dashboard agree.

## Description


## Comments
