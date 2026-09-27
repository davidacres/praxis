---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:15:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-145
title: "Dedicated Agent Details center page (Activity feed, tool executions, and file edits)"
status: Complete
feature: FX-BF-046
updated: 2026-09-26
dependencies: [FX-BE-144]
---

# FX-BE-145: Dedicated Agent Details center page (Activity feed, tool executions, and file edits)

## User or operational impact

Gives users a focused, high-clarity center page dedicated exclusively to inspecting what a specific agent or subagent is doing in real-time, including tool invocations, bash executions, file edits (with diffs and undo), reasoning logs, and token/cost telemetry.

## Scope

- **New Center Page (`AgentActivityPage.tsx`)**:
  - Located in `apps/praxis-desktop/renderer/src/ai/AgentActivityPage.tsx`.
  - Inset card layout matching Praxis standard (`--pane-main-inset: 4px`, rounded corners, border).
- **Header Card**:
  - Agent title and role attribution.
  - Linked session key (clickable to navigate back to full session conversation).
  - Model badge (e.g., `claude-3-7-sonnet`, `gpt-4o`).
  - Execution state badge (`Completed`, `Failed`, `Running`) with live timer.
  - Token consumption and cost telemetry (when available from `tokenUsage` / `cost`).
- **Activity Timeline**:
  - Chronological activity log showing:
    - **Tool executions**: tool name, inputs/arguments, execution duration, and results.
    - **File changes**: touched file paths, diff visualization, and "Undo edit" action using `window.praxis.ai.undoToolFileChange`.
    - **Thought & Reasoning**: formatted thought blocks with collapsible disclosure.
    - **Lifecycle markers**: start, pause, resume, and completion events.
    - **Diagnostics banner**: error details and stack traces when state is `failed`.
- **Routing Integration**:
  - Extend `Route` in `App.tsx` with `view: 'agent-details'`, `sessionKey`, and `subagentId`.
  - In `centre()` routing, render `<AgentActivityPage />` when `route.view === 'agent-details'`.

## Visual and interaction design

- **Hero Header**:
  - Background: `var(--bg-elevated)`.
  - Border: `var(--border)`.
  - Identity icon: Provider glyph or `<Icon name="robot" size={24} />`.
- **Timeline Items**:
  - Left border indicator line connecting sequential actions.
  - Tool cards with subtle background (`var(--bg-sunken)`), monospace arguments, and syntax-highlighted diffs.
- **Diff & Undo Action**:
  - Leverages Praxis `undoToolFileChange` IPC with in-app confirmation modal (`useDialogs()`).

## Acceptance criteria

- Clicking any agent sub-item in the EasyMode sidebar routes the center pane to the Agent Details page.
- Displays agent identity, model, status, token usage, cost, and elapsed time.
- If the agent performed tool operations, displays each tool call with its parameters and execution result.
- If the agent wrote file changes, displays the file diff and offers an "Undo edit" action.
- When an agent execution fails, a prominent diagnostics banner explains the root cause.
- Keyboard navigation and focus rings comply with `:focus-visible` standards.

## Validation

- `npm run check-core-imports`
- `npm run check-types`
- `npm run build:renderer`
- Playwright spec asserting navigation to Agent Details page and visibility of tool events and telemetry.

## Comments

Completed TASK-380 and TASK-381. Implemented `AgentDetailsPage.tsx`, `AgentActivityFeed.tsx`, and `ToolExecutionCard.tsx`, wired into `App.tsx` center pane routing with breadcrumbs, live telemetry, status indicators, expandable thoughts and tools, file diffs, and undo capabilities. Typecheck and build passed cleanly.

## Description


## Dependencies


