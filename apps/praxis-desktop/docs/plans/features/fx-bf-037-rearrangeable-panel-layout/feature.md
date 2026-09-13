---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-037
title: "Rearrangeable panel layout"
status: Proposed
updated: 2026-09-13
dependencies: [FX-BF-005, FX-BF-008, FX-BF-017]
---

# FX-BF-037: Rearrangeable panel layout

## Outcome

A user can drag any region of the desktop shell — sidebar, main/center content, contextual aux panel, and bottom panel — into any other region, and the app remembers the arrangement across restarts. Panel *identity* (what a panel is: Sidebar, board/doc content, session inspector, bottom panel) becomes independent of panel *position*, so "move the right panel to the left" is a supported layout operation rather than a fixed dock.

## Scope

- A layout model that separates each pane's rendered content from the region it occupies (`left | right | center | bottom`, extensible to split/tabbed regions later).
- Generic panel shell chrome (title bar, drag handle, collapse) wrapping the existing Sidebar, routed main content, contextual aux content, and BottomPanel so any of them can render in any region.
- Drag-and-drop interactions to move a panel to a new region, including drop-zone affordances and keyboard-accessible fallback (a "Move panel to…" menu) for users who cannot drag.
- Persisting the arrangement in `AppSettings` (core), mirrored in the renderer's `settingsDefaults.ts`, so layout survives app restarts and is restorable to defaults.
- Preserving existing per-region sizing (`useResizable` splitters) once panels can move — sizes are remembered per region, not per panel identity.
- Compliance with the app's existing conventions for any new draggable/dockable chrome: the surface-pack material recipe, the global `:focus-visible` ring, and the CSP's `img-src data:` requirement.

## Non-goals

- Arbitrary free-floating/undocked (windowed) panels — this feature covers docking into the four existing region slots, not a full floating-window manager.
- Multiple simultaneous panels stacked as tabs within one region (tabbed regions) — noted as a natural follow-on, not required for this feature.
- Changing what each panel renders or its internal behavior (Sidebar tree, board/doc content, session inspector, bottom panel contents are unchanged, only their container/position).
- Per-project or per-user-role layout profiles — one arrangement per app installation, matching how other appearance settings persist today.

## Stories

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-102 | Panel and layout region model | Proposed | FX-BF-005 |
| FX-BE-103 | Generic panel shells and content adapters | Proposed | FX-BE-102 |
| FX-BE-104 | Drag-and-drop docking interactions | Proposed | FX-BE-103 |
| FX-BE-105 | Persisted layout settings | Proposed | FX-BE-102, FX-BF-017 |
| FX-BE-106 | Accessibility, theming and verification | Proposed | FX-BE-104, FX-BE-105 |

## Description


## Dependencies



## Comments


