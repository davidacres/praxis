---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-302
title: "Load persisted layout on startup and save debounced on change"
status: Proposed
story: FX-BE-105
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-300, TASK-301]
---

# TASK-302: Load persisted layout on startup and save debounced on change

## Objective

On shell mount, read `layout` from settings and initialize the region-render state from it (falling back to the FX-BE-102 default when absent); on every panel move or region resize, persist the updated `layout` back to settings, debounced to avoid a write per pixel while dragging a splitter.

## Implementation notes

- Debounce the resize-triggered save (e.g. only persist after the drag/resize gesture ends), but persist a panel move immediately on drop since it's a discrete action, not a continuous one.
- Use the existing `settings.onChanged` subscription so a layout change made in one window (if ever relevant) reflects elsewhere, consistent with how other settings propagate.
- Do not write to settings during the initial load itself (avoid a load → sanitize → immediate re-save loop).

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run an e2e test that rearranges a panel, reloads the app window, and asserts the same arrangement and region sizes are restored.

## Description


## Dependencies



## Comments
