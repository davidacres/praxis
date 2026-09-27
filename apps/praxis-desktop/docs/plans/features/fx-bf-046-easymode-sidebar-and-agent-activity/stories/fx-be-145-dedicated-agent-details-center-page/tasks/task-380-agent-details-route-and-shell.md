---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-380
title: "Create Agent Details route integration, top bar, and center pane shell"
status: Complete
story: FX-BE-145
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-378]
---

# TASK-380: Create Agent Details route integration, top bar, and center pane shell

## Goal

Provide a dedicated center pane route and container for inspecting an individual agent or subagent's execution, including top status bar with duration, model, tokens, and navigation breadcrumbs.

## Dependencies

- TASK-378

## Execution track

- **Track D (Agent Details View)**: Unblocks `TASK-381` (Activity Timeline, Diffs & Undo).

## Scope

- In `apps/praxis-desktop/renderer/src/routes.tsx` (or view router):
  - Register route for `/agent/:agentId` (or view state `activeView === 'agent-details'`).
- In `apps/praxis-desktop/renderer/src/components/agent-details/AgentDetailsPage.tsx`:
  - Create the floating center card container respecting `--pane-main-inset: 4px` and rounded borders.
  - Implement top header bar:
    - Agent name and role badge (Primary Agent vs Subagent).
    - Session parent title and back link / breadcrumb.
    - Live status indicator (glowing dot, elapsed timer, token count, cost).
    - Stop / Cancel button if the agent is actively executing.

## Acceptance criteria

- Selecting an agent in the EasyMode sidebar transitions the center pane to `<AgentDetailsPage />`.
- Header shows agent identity, status, elapsed duration, and model/token telemetry.
- Preserves the floating center card inset and border radius standard of the Praxis desktop UI.

## Validation

- `npm run check-types`
- `npm run check-core-imports`

## Description


## Comments

Implemented `AgentDetailsPage.tsx` and routed view state `view === 'agent-details'` in `App.tsx`. The center pane renders a floating card with inset standard, top header bar displaying back button, breadcrumb hierarchy, agent role badge, live status dot and label, duration timer, model/token/cost telemetry, abort action button, and a subagent switcher bar. Typechecked and verified with `check-core-imports` and `check-types`.
