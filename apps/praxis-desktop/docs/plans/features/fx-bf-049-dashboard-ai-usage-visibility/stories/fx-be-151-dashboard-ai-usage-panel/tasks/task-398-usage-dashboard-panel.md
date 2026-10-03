---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-398
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Build the Overview dashboard AI usage panel

## Files and integration points

A new panel component in `apps/praxis-desktop/renderer/src/app/` — the folder
that owns the Overview screen — rendered from `OverviewPage.tsx`; a new
`onOpenAiUsage` prop on `OverviewPage` wired in `App.tsx` to the existing
`setSettingsDialogCategory('ai-usage')` call; new `.overview-usage-*` rules
appended to the existing overview section of `renderer/src/styles/theme.css`; and
reuse of `formatTokenCount` / `formatCost` from `ai/sessionNav.ts`. Read
`renderer/AGENTS.md` first — it governs the surface, theming and verification
rules for a change like this.

## Scope

Place the panel full width between the "Start here" strip and the Active AI
sessions / Recent conversations / Recent projects row. Above that row because
this is summary data and belongs with the stat tiles; below it would sit under
activity content. It must not disturb the layout of any existing panel.

Contents: a header with an updated-at line and a "View details" action; four
period tiles — today, this week, this month, all time — each showing tokens,
cost and one peak line ("peak 240k · Tue"); and a "Top models" list with rank,
model name, a token share bar, tokens, share percentage and per-model cost, plus
a period selector for that list.

Reuse the existing stat-tile visual language rather than inventing a second one.
The four tiles are read-only — no period switch on them. Self-fetch through the
new IPC read, following the pattern the "Agent runtime" widget on this same page
already uses, so the panel does not need new props threaded down.

Three states, all required: an empty workspace with a call to start a
conversation; usage present but no cost reported, saying cost comes from ACP
agents only; and the normal populated state. The all-time tile is labelled
`All time (since <first event date>)`. A footnote states that totals differ from
Settings → AI → Spend because Spend excludes internal one-shot AI calls.

Styling uses theme tokens only — no literal colours — so all four theme axes
inherit it with no per-theme override. Multi-currency cost is labelled, never
converted.

## Dependencies

TASK-397

## Done conditions and validation

`npm run check-types` and `npm run build` pass for the renderer, including the
core-import check. Visually inspect the running app at all three states and in
all four theme axes; a green suite does not mean it looks right. Confirm the
panel does not reflow the panels below it, that the peak line reads correctly
when a period has no data, and that "not reported" never renders as `$0.00`.
Retain useful screenshots under `.praxis/session-artifacts/`.

## Description


## Comments
