---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:15:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-144
title: "EasyMode sidebar workspace (Sessions, Automations, and Orca card hierarchy)"
status: Complete
feature: FX-BF-046
updated: 2026-09-26
dependencies: []
---

# FX-BE-144: EasyMode sidebar workspace (Sessions, Automations, and Orca card hierarchy)

## User or operational impact

Provides a streamlined, modern workspace sidebar for users who want a task- and agent-focused environment without complex folder or project tree hierarchies. Inspired by Orca (`onorca.dev`), it presents active sessions and automations with live visual feedback, card grouping, and glowing status indicators.

## Scope

- **Full-area panel**: When `settings.preview.enableEasyMode` is true, render `<EasyModeSidebar />` filling 100% of `.pane-sidebar`. All standard panels (Projects tree, Boards, WorkMode, splitter, Praxis footer) are suppressed.
- **Header Section Pattern**:
  - Reusable section header: section label on the left, right-aligned `+` button on the same line.
  - Sized from `--tree-indent-1` and `--tool-btn-size`.
  - Icon: `<Icon name="plus" size={13} />`.
  - Tooltip: via `aria-label` ("Create new session", "Create new automation run").
- **Sessions Section**:
  - Lists created `AgentSessionRecord` items.
  - Each session renders inside a `.easymode-session-card`.
  - Nested sub-items represent executing agents:
    - Primary agent (with role and model).
    - Subagents extracted via `extractSubagents` (child sessions linked by `parentSessionKey` + tool-invoked subagents from events).
  - Status Indicators:
    - Red dot/icon for failed (`state === 'failed'`).
    - Green dot/icon for success (`state === 'completed'`).
    - Glowing pulsing dot while in-progress (`running`, `executing`, `planning`).
  - Selection Highlight:
    - When a session is selected and contains agents/subagents, the entire session card container receives:
      - Highlight border: `1px solid var(--accent-border)` (or `rgba(255, 255, 255, 0.40)`).
      - Rounded corners: `border-radius: var(--radius-sm, 6px)`.
      - 20% opaque white background: `background: color-mix(in srgb, #ffffff 20%, transparent)` (dark mode) / `color-mix(in srgb, var(--accent) 12%, var(--bg-elevated))` (light mode).
- **Automations Section**:
  - Header: "Automations" + `+` button triggering workflow run creation dialog.
  - Lists workflow runs from `runsByProjectId` (flattened across projects, newest first).
  - Each item shows workflow name, status tone, run ID, and relative timestamp.
  - Clicking an automation selects it and opens `WorkflowRunPage` in the center pane.

## Visual and interaction design

- **Card Styling**:
  - Base: `border: 1px solid transparent`, `border-radius: var(--radius-sm, 6px)`.
  - Hover: `background: var(--bg-hover)`, `border-color: var(--border)`.
  - Selected: `border-color: var(--accent-border)`, `background: color-mix(in srgb, #ffffff 20%, transparent)`, `box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35)`.
- **Glow Animation Specification**:
  - `@keyframes easymode-glow`: pulses between 4px and 12px blur radius with opacity scale 0.65 to 1.0.
  - Animation duration: 1.5s ease-in-out infinite.
  - Fallback: `@media (prefers-reduced-motion: reduce)` disables animation and uses a static 4px glow.
- **Icons**:
  - `plus` (13px) for section headers.
  - `robot`, `provider-claude`, `provider-openai`, `provider-codex` for agent types.
  - `check` (10px) for success, `warning` (12px) for failure.

## Acceptance criteria

- With `enableEasyMode: true`, the sidebar renders only the EasyMode panel with Sessions and Automations.
- Both Sessions and Automations headers display a right-aligned `+` button on the exact same line as the title.
- Clicking `+` on Sessions triggers `onNewSession()` (opens session composer).
- Clicking `+` on Automations opens workflow run creation.
- A session running with agents/subagents displays sub-items with:
  - Green dot for completed.
  - Red dot for failed.
  - Glowing animated dot for running.
- Selecting a session with subagents wraps the entire list in a highlighted card with rounded corners, a border, and a 20% opaque white background.
- Selecting an agent sub-item triggers navigation to the Agent Details page.
- Selecting an automation opens the workflow run monitor in the center pane.
- Respects system reduced-motion settings by disabling keyframe animations.
- All icon-only buttons display accessible tooltips on hover.

## Validation

- `npm run check-core-imports`
- `npm run check-types`
- `npm run build:renderer`
- Add focused Playwright e2e test in `apps/praxis-desktop/main/e2e/easyModeSidebar.spec.ts`.

## Comments

All child tasks (TASK-377, TASK-378, TASK-379) are complete. The `EasyModeSidebar` full-panel host, `SectionHeader` with right-aligned `+` action button, card-based Sessions list with subagent extraction, live status indicators (red failed, green success, glowing pulse running), selected session 20% white background and highlight border, and Automations workflow runs section are fully implemented and styled.

## Description


## Dependencies


