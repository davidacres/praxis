---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-299
title: "Add a keyboard-accessible Move panel to… menu"
status: Proposed
story: FX-BE-104
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-297]
---

# TASK-299: Add a keyboard-accessible "Move panel to…" menu

## Objective

Give every `PanelShell` a small menu button (reachable by Tab, activatable by Enter/Space) listing the other available regions; choosing one relocates the panel through the same layout-config update path as a completed drag.

## Implementation notes

- Reuse existing menu/dropdown primitives from `ui/` rather than introducing a new one.
- The menu must not remove or fight the global `:focus-visible` ring; it is additive UI, not a focus-handling change.
- Route the "move to region" action through the exact same state update TASK-297 uses for a drop, so drag and menu paths cannot drift apart in behaviour.
- Disable/omit the current region from its own menu (a panel cannot "move" to where it already is).

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` with e2e coverage driving the menu via keyboard only (no mouse) for every panel/region pair, and re-run `e2e/keyboardFocus.spec.ts` to confirm the new control doesn't erode the focus ring.

## Description


## Dependencies



## Comments
