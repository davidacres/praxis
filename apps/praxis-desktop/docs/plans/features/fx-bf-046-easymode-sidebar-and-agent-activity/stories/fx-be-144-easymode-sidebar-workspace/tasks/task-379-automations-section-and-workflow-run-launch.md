---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-379
title: "Implement EasyMode Automations section with workflow run triggers and dialog"
status: Complete
story: FX-BE-144
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-377]
---

# TASK-379: Implement EasyMode Automations section with workflow run triggers and dialog

## Goal

Provide the Automations section in the EasyMode sidebar displaying recent workflow runs with status badges and timestamps, and wire the section header `+` button to launch a new workflow run via workflow selection dialog.

## Dependencies

- TASK-377

## Execution track

- **Track C2 (Sidebar Automations)**: Can be implemented concurrently with Sessions (`TASK-378`).

## Scope

- In `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeAutomationsList.tsx`:
  - Query active and past workflow runs from existing workflow stores.
  - Render list of workflow runs showing workflow name, execution timestamp, and status icon (queued, running, succeeded, failed).
  - Clicking a workflow run navigates to the workflow run monitor/workspace view.
  - Wire section header `+` button to open the workflow run launcher dialog (using `useDialogs()`).

## Acceptance criteria

- Automations section lists workflow runs with appropriate status icons and times.
- Header `+` button triggers the workflow run launcher dialog.
- Clicking an automation item navigates to its workflow run workspace.

## Validation

- `npm run check-types`
- `npm run check-core-imports`

## Description


## Comments

Implemented `EasyModeAutomationsList` in `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeAutomationsList.tsx` showing active and recent workflow runs sorted descending by started timestamp. Connected status icons with appropriate tones (success, running, failed, idle). Wired the header `+` button in `EasyModeSidebar` to launch workflow runs through `onNewWorkflowRun` (triggering `setStartRunDialog`), and wired selecting an automation item to navigate directly to the workflow run monitor/workspace view (`onSelectWorkflowRun`). All styles and accessibility attributes implemented and typecheck clean.
