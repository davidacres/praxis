---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-404
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Global Assistant drawer shell with docked vs floating state and resize handle

## Files and integration points

- `apps/praxis-desktop/renderer/src/assistant/AssistantShell.tsx` (new): Outer container managing floating vs docked display mode, position, and open/close state.
- `apps/praxis-desktop/renderer/src/app/App.tsx`: Mounts `AssistantShell`, connects global keydown listener (`Cmd+J` / `Ctrl+J`), and integrates docked mode with the window layout grid.
- `apps/praxis-desktop/renderer/src/app/TitleBar.tsx`: Adds assistant toggle button with active glow state beside pane toggles.
- `apps/praxis-desktop/renderer/src/theme.css`: CSS styling for `.assistant-shell`, `.assistant-floating`, `.assistant-docked`, backdrop effects, and resize divider.

## Implementation details

- State model:
  - `open: boolean`: Whether assistant is visible.
  - `docked: boolean`: When false, renders as a bottom-right floating popover (`z-index: 100`). When true, docks into the right-hand panel column next to `.pane-main`.
  - Remembers docked width and user preference in `localStorage` (`tm-assistant-docked`, `tm-assistant-width`).
- Header controls:
  - Title and active persona roster status.
  - Pin toggle button (`[📌 Pin]` / `[Unpin]`) that morphs between floating and docked without remounting or losing conversation state.
  - Close button (`<Icon name="close" />`).
- Surface pack compliance: Overlays carry `--surface-backdrop`, `--surface-panel-tint-layer`, and theme token backgrounds as mandated by `apps/praxis-desktop/renderer/AGENTS.md`.

## Testing and verification criteria

- Pressing `Cmd+J` toggles visibility from any screen.
- Clicking the Pin button transitions the panel smoothly from floating to docked column, and the main card shrinks accordingly.
- Resizing the docked divider persists the chosen width.
