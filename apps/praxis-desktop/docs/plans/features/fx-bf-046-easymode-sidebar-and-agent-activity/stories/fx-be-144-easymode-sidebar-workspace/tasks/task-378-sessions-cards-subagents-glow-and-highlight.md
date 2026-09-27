---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-378
title: "Implement EasyMode Sessions card list, subagents hierarchy, status glow, and selection highlight"
status: Complete
story: FX-BE-144
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-377]
---

# TASK-378: Implement EasyMode Sessions card list, subagents hierarchy, status glow, and selection highlight

## Goal

Render the card-based Sessions section in EasyMode. Display sessions and child subagents with real-time status indicators (red failed, green success, pulsing glow in-progress). Wrap the selected session and its subagent list in a rounded highlight border with 20% opaque white background. Clicking `+` opens session creation.

## Dependencies

- TASK-377

## Execution track

- **Track C1 (Sidebar Sessions)**: Can be implemented concurrently with Automations (`TASK-379`). Unblocks Agent Details route (`TASK-380`).

## Scope

- In `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSessionsList.tsx`:
  - List all active/recent agent sessions.
  - Extract subagents for each session using `extractSubagents(session, allSessions)`.
  - Wire header `+` button to open the new session dialog or trigger session initialization.
- In `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSessionCard.tsx`:
  - Display session title, time, and expandable/visible subagent tree.
  - Implement sub-item status dots:
    - Failed: Solid red (`var(--tone-error, #f87171)`).
    - Success / Done: Solid green (`var(--tone-success, #4ade80)`).
    - In progress: Pulsing glow animation (`@keyframes easymode-glow`).
  - Active selection state: Apply highlight border with slightly rounded corners (`border-radius: var(--radius-md, 8px)`) and 20% opaque white background (`background: color-mix(in srgb, #ffffff 20%, transparent)`).
  - Clicking an agent sub-item navigates to the dedicated Agent Details view (`/agent/:agentId`).

## Acceptance criteria

- Sessions render as cards with child agents nested underneath.
- In-progress agents exhibit a smooth 2-second glowing box-shadow pulse (with `@media (prefers-reduced-motion)` fallback).
- Failed agents show red indicator; completed agents show green indicator.
- Selected session shows highlight border and 20% white background encompassing the session and all its subagent sub-items.
- Clicking the Sessions header `+` button opens session creation.

## Validation

- `npm run check-types`
- `npm run check-core-imports`

## Description


## Comments

Implemented `EasyModeSessionCard` and `EasyModeSessionsList` in `apps/praxis-desktop/renderer/src/components/sidebar/`. Subagents are extracted via `extractSubagents(session, allSessions)` and rendered under their session card. Status indicators implemented with solid green for complete, solid red for failed, and `@keyframes easymode-glow` pulse animation for in-progress agents (respecting `prefers-reduced-motion`). Selected session card applies highlight border with rounded corners and `background: color-mix(in srgb, #ffffff 20%, transparent)` encompassing the session card and its child agents. Clicking an agent navigates to the Agent Details route with agent ID and session key. Type checks and core imports verified clean.
