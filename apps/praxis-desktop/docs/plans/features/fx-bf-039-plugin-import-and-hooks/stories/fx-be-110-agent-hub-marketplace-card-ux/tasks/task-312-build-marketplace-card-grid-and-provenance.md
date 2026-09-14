---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-312
title: "Build the marketplace card grid and provenance display"
status: Proposed
story: FX-BE-110
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-110, TASK-310, TASK-307]
---

# TASK-312: Build the marketplace card grid and provenance display

## Objective

Implement FX-BE-109/TASK-310's card-grid design: add/remove a plugin source in
Settings, browse its plugins as cards (not a settings list), and show provenance on
every imported profile/skill/server wherever it's rendered elsewhere in the app.

## Implementation notes

- Build the card grid as its own component reusing the theme marketplace's card
  primitives where they genuinely apply (card shell, install-state badge) — don't
  duplicate that component wholesale, but don't force-fit an unrelated one either;
  follow the signed-off design from TASK-310 over either extreme.
- A source add must not block on resolving every plugin's full file tree — list
  first from the cached/fetched `marketplace.json` (TASK-307), resolve individual
  plugin contents lazily when a card is opened.
- An imported profile is a `DiscoveredAgentProfile` like any other once converted
  (TASK-308) — the provenance badge is additive rendering on existing catalog rows,
  not a parallel "imported items" section the rest of the Agent Hub doesn't know
  about.

## Acceptance criteria

- Card grid matches the signed-off TASK-310 design in its empty and populated
  states, including light/dark/surface-pack theming.
- Provenance badge appears everywhere an imported item is rendered, with no
  exceptions found in manual review of the designer, composer, and Agent Hub.
- Adding/removing a source updates the grid without a full settings reload.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the new card-grid e2e coverage and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
