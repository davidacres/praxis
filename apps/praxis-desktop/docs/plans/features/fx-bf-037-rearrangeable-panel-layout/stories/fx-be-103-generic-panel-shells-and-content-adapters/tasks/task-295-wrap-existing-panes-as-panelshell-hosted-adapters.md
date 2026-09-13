---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-295
title: "Wrap existing panes as PanelShell-hosted adapters"
status: Proposed
story: FX-BE-103
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-294]
---

# TASK-295: Wrap existing panes as PanelShell-hosted adapters

## Objective

Wrap Sidebar, the routed main content, the contextual aux content (currently keyed off `route.feature`), and BottomPanel each in a thin adapter that supplies a `PanelShell` title/icon and renders the existing component unchanged inside it.

## Implementation notes

- Each adapter is a small wrapper, not a rewrite — the existing Sidebar/aux/BottomPanel components keep their current props, state and behavior.
- The aux content's title must reflect whatever `route.feature` currently drives (e.g. "Session", "Board details") so the shell's title bar stays meaningful as routing changes.
- Wire adapters through the `PanelId` → component mapping introduced in TASK-292, replacing the direct JSX references.
- No new CSS token or bespoke styling per adapter — all chrome comes from `PanelShell` itself (TASK-294).

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` full e2e suite and confirm no change to existing sidebar/aux/bottom-panel specs beyond the new chrome wrapper.

## Description


## Dependencies



## Comments
