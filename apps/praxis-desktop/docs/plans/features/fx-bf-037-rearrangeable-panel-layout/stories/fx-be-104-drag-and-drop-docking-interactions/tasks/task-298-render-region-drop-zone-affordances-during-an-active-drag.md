---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-298
title: "Render region drop-zone affordances during an active drag"
status: Proposed
story: FX-BE-104
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-297]
---

# TASK-298: Render region drop-zone affordances during an active drag

## Objective

While a panel is being dragged, highlight every valid drop-zone region so the user can see where it can land, and show a snap preview (or equivalent affordance) for the region currently under the pointer.

## Implementation notes

- Highlight styling must follow this app's token-based theming rule — no hard-coded colour; use existing accent/border tokens so it composes with every theme and surface pack.
- The highlighted overlay sits above pane content but must not block the drop event itself (mirrors the existing "grain/motif layers never take pointer events" pattern used elsewhere in the shell).
- Ensure the affordance clears reliably on `dragend`/`drop`/mouse-leave-window, so a cancelled drag never leaves a stuck highlight.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` and capture a screenshot of an in-progress drag to confirm the drop-zone highlight renders correctly under at least one non-default surface pack and theme.

## Description


## Dependencies



## Comments
