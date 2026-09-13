---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-297
title: "Add drag-and-drop wiring to PanelShell and region containers"
status: Proposed
story: FX-BE-104
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-104]
---

# TASK-297: Add drag-and-drop wiring to PanelShell and region containers

## Objective

Make each `PanelShell`'s title-bar handle a native HTML5 drag source (`draggable`, `dragstart`/`dragend`) carrying its `PanelId`, and make each region container a drop target (`dragover`/`drop`) that updates the layout config on drop.

## Implementation notes

- Prefer native HTML5 drag-and-drop over a new dependency, consistent with this app not previously carrying DnD infrastructure — only introduce a library if native DnD proves insufficient for the drop-zone/preview needs in TASK-298.
- On drop, update the shared `LayoutConfig` state (from FX-BE-102) rather than mutating any component's local state directly, so the region-render loop picks up the change uniformly.
- Do not allow a panel to be dropped onto itself (no-op) or onto an invalid/unknown region id.
- Keep drag state (which panel is being dragged, over which region) in a small dedicated hook/context so `PanelShell` and every region container consume the same source of truth.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results (e.g. an invalid drop is a no-op, not a crash).
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` with new e2e coverage simulating `dragstart`/`dragover`/`drop` events across all four regions.

## Description


## Dependencies



## Comments
