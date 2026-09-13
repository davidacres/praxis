---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-292
title: "Refactor App.tsx to render regions from the layout config"
status: Proposed
story: FX-BE-102
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-291]
---

# TASK-292: Refactor App.tsx to render regions from the layout config

## Objective

Replace `App.tsx`'s hard-coded `.shell` / `editor-stack` / `.pane-row` JSX nesting with a render loop driven by the `LayoutConfig` resolver from TASK-291, so each region renders whichever `PanelId` is currently assigned to it.

## Implementation notes

- Preserve existing CSS class names and structure (`pane-sidebar`, `pane-main`, `pane-aux`, `panel-dock`) where the DOM shape stays the same, to avoid an unrelated styling rewrite in this task.
- The routed main content (board/doc/session) and the contextual aux content (keyed off `route.feature`) must continue to receive the same props/context they do today regardless of which physical region they render into.
- `useResizable` splitter wiring must be re-attached per region, not per panel identity, since a region's size should persist even if its content changes.
- Do not change what any individual panel renders — only where it renders.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- The default layout config reproduces the exact current DOM structure and visual output.
- The implementation remains compatible with desktop and mobile renderers (no core value imports leaking into the renderer bundle).
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the full e2e suite and visually diff a baseline `toHaveScreenshot` capture of the shell before and after the refactor.

## Description


## Dependencies



## Comments
