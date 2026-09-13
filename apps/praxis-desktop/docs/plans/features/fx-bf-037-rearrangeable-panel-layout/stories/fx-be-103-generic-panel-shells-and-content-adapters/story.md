---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-103
title: "Generic panel shells and content adapters"
status: Proposed
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-102]
---

# FX-BE-103: Generic panel shells and content adapters

## Outcome

Every region-hosted panel (Sidebar, main/routed content, contextual aux, bottom panel) is wrapped in a common shell with a title bar and drag handle, so any of them can be mounted in any region without changing what they render internally.

## Tasks

- **TASK-294 Build a generic `PanelShell` component (title bar, drag handle, collapse control).**
- **TASK-295 Wrap Sidebar, main/routed content, aux content and BottomPanel as `PanelShell`-hosted adapters.**
- **TASK-296 Give the main/routed content a title bar and header chrome equivalent to the other panels.**

## Acceptance

The story is complete when every one of the four existing panels renders inside the same `PanelShell` chrome, keeps its existing internal behavior and props untouched, and can be mounted in any region (verified by swapping the default layout config in code) without visual or functional regression.

## Evidence

Component-level snapshot tests for `PanelShell` in each of its four hosted configurations, plus an e2e capture confirming no regression to the default arrangement's look.

## Description


## Dependencies



## Comments
