---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-399
type: Task
status: Backlog
created: 2026-10-03
priority: Medium
---

# Add the model breakdown to the AI usage settings page

## Files and integration points

`apps/praxis-desktop/renderer/src/settings/AiUsageStatsSection.tsx`, reading
the same aggregation the dashboard reads. Read the AI provider settings notes in
`renderer/AGENTS.md` before changing this surface.

## Scope

Add the per-model breakdown — model, tokens, share, and cost or "not reported" —
to the existing AI Usage settings page, under the chart and the event table.

This is what makes the dashboard trustworthy. The Overview panel is a summary of
this page, so if the two can disagree the panel becomes a second answer that is
subtly wrong. Both read the same core aggregation, so the figures are identical
by construction.

Reuse the shared `formatTokenCount` / `formatCost` helpers rather than this
section's private copies, and drop the duplicated local versions once both
surfaces use the shared ones. Apply the same honest-cost treatment as the
dashboard: absent cost is labelled, not zeroed.

## Dependencies

TASK-396

## Done conditions and validation

The Settings page and the Overview panel show identical figures for the same
period, verified visually in the running app with a seeded ledger. Confirm the
removed private formatters have no other callers before deleting them. Renderer
`check-types` and `build` pass, including the core-import check.

## Description


## Comments
