---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-102
title: "Panel and layout region model"
status: Proposed
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BF-005]
---

# FX-BE-102: Panel and layout region model

## Outcome

Define the data model that separates *panel identity* (Sidebar, main/routed content, contextual aux, bottom panel) from *region placement* (`left | right | center | bottom`), and drive `App.tsx`'s current fixed JSX nesting from that model instead of hard-coded structure.

## Tasks

- **TASK-291 Define `PanelId`/`RegionId` types and the layout-config shape in core.**
- **TASK-292 Refactor `App.tsx`'s shell/editor-stack/pane-row nesting to render regions from the layout config.**
- **TASK-293 Provide a default layout config matching today's fixed arrangement, with a reset-to-default path.**

## Acceptance

The story is complete when the shell renders identically to today under the default config, every existing pane (Sidebar, main content, aux content, bottom panel) is addressable by a stable `PanelId`, and swapping two entries in the layout config (in code, ahead of drag-and-drop) visibly relocates the corresponding panel with no loss of content or behavior.

## Evidence

Unit tests for the layout-config resolution logic, and an e2e snapshot proving the default arrangement is pixel-identical to the pre-refactor shell.

## Description


## Dependencies



## Comments
