---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-310
title: "Design the marketplace browsing, preview, and trust-diff experience"
status: Proposed
story: FX-BE-109
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-109]
---

# TASK-310: Design the marketplace browsing, preview, and trust-diff experience

## Objective

Produce a reviewable visual design for browsing plugin sources, previewing an
agent/skill/MCP server before installing it, and reviewing a diff when an update
changes something that needs re-trust.

## Implementation notes

- Start from Praxis's existing theme marketplace card pattern (live mini-previews,
  install state on the card itself) rather than the plainer Add-ons settings list —
  the whole point of this story is that this surface should read as a showcase, not
  a config screen. Reuse the surface-pack/theme grid's visual rhythm; do not
  reinvent card proportions or spacing from scratch.
- The preview state needs to show, per content type: an agent's full instructions
  body (not just its description), a skill's full SKILL.md body, and — once
  FX-BE-111's hook contract exists — a hook's plain-English matcher/action summary.
  Design this as an expansion of the card or a side panel, not a navigation away
  from the browsing grid.
- The trust-diff view (shown on first install and on any update that changes
  executable content) needs a real diff — old script/URL vs. new — not a bare
  "this plugin wants to do X, allow?" restatement. Model it visually after the
  session inspector's own diff rendering (`ToolDiff`) so it feels native to Praxis,
  not a foreign dialog.
- Cover empty state (no sources added yet) as a real design, not an afterthought —
  this is a new user's first impression of the feature.

## Acceptance criteria

- Mocked states: empty, populated grid, expanded preview (agent/skill/MCP), and the
  trust-diff dialog for an update.
- Visually consistent with the existing theme marketplace and session diff patterns,
  not a new, one-off visual language.
- Reviewed and signed off before FX-BE-110 begins implementation against it.
- Relevant documentation and plan references are updated.

## Verification

Design review against Praxis's light/dark/surface-pack theme matrix — the mock must
hold up in at least one dark and one light theme, not just the default look.

## Description


## Dependencies



## Comments
