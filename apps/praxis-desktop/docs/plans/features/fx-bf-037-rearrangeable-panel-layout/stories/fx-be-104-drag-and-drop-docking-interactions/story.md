---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-104
title: "Drag-and-drop docking interactions"
status: Proposed
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-103]
---

# FX-BE-104: Drag-and-drop docking interactions

## Outcome

A user can drag any `PanelShell`'s handle and drop it onto a drop-zone overlay for another region to relocate it, with a keyboard-accessible "Move panel to…" fallback for anyone who cannot or does not want to drag.

## Tasks

- **TASK-297 Add drag-and-drop wiring (drag source + drop targets) to `PanelShell` and the region containers.**
- **TASK-298 Render region drop-zone affordances during an active drag (highlight, snap preview).**
- **TASK-299 Add a keyboard-accessible "Move panel to…" menu as a non-drag alternative on every `PanelShell`.**

## Acceptance

The story is complete when dragging any panel's handle onto any other region's drop zone relocates it live, the two panels' prior contents swap or reflow predictably (documented and consistent), the same relocation is achievable entirely from the keyboard via the menu fallback, and the resulting arrangement renders through the layout config from FX-BE-102 with no special-cased DOM.

## Evidence

Playwright e2e coverage exercising drag interactions (via mouse-event simulation) and the keyboard fallback menu for every pairwise region swap, plus a manual verification note since drag-and-drop is inherently hard to fully assert.

## Description


## Dependencies



## Comments
