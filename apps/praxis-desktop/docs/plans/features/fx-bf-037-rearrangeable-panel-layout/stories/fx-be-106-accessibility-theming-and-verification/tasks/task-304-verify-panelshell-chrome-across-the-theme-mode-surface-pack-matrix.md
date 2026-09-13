---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-304
title: "Verify PanelShell chrome across the theme/mode/surface-pack matrix"
status: Proposed
story: FX-BE-106
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-104]
---

# TASK-304: Verify PanelShell chrome across the theme/mode/surface-pack matrix

## Objective

Capture and review `toHaveScreenshot` baselines of `PanelShell`'s title bar/drag handle and the drop-zone highlight under at least one non-default `data-theme`, both `data-mode` values, and at least one non-`flat` `data-surface` pack, confirming the material recipe (panel tint, accent glow, backdrop-filter, radius boost) is applied and CSP's `img-src data:` is unaffected by any new inline SVG/watermark usage.

## Implementation notes

- Follow this repo's rule literally: regenerating a snapshot is not verification — open every `-actual.png`/diff produced and confirm intent before accepting.
- Reuse `refreshSurfacePattern`/`tm-theme-changed` wiring rather than inventing a new theme-refresh path for any baked-in pattern colour used by the new chrome.
- Explicitly test that the drop-zone overlay never blocks pointer events on underlying pane content, matching the existing grain/motif z-index convention.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the targeted `toHaveScreenshot` specs for the new chrome across the selected theme/mode/surface combinations and manually review each accepted baseline.

## Description


## Dependencies



## Comments
