---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:25:00.000Z
**Type:** Task
**Priority:** High
id: TASK-381
title: "Implement Agent Activity timeline, live events, tool args, file diffs, and undo action"
status: Complete
story: FX-BE-145
feature: FX-BF-046
updated: 2026-09-26
dependencies: [TASK-380]
---

# TASK-381: Implement Agent Activity timeline, live events, tool args, file diffs, and undo action

## Goal

Render the comprehensive activity timeline inside the Agent Details page, including streamed reasoning thoughts, collapsible tool execution items with syntax-highlighted inputs/outputs, inline file diffs for file edits, and undo action buttons.

## Dependencies

- TASK-380

## Execution track

- **Track D (Agent Details View)**: Completes the activity viewer and diff engine. Unblocks final E2E verification (`TASK-382`).

## Scope

- In `apps/praxis-desktop/renderer/src/components/agent-details/AgentActivityFeed.tsx`:
  - Stream events for the selected agent session (`agentSessionStore.getSessionEvents(agentId)`).
  - Render chronological timeline cards:
    - User prompts and model reasoning thought streams.
    - Tool invocation entries (tool name, duration, status icon).
- In `apps/praxis-desktop/renderer/src/components/agent-details/ToolExecutionCard.tsx`:
  - Collapsible payload viewer for tool arguments and returned output.
  - For file-writing tools (`write_to_file`, `replace_file_content`):
    - Render unified or split diff viewer of file changes.
    - Provide an "Undo Changes" button calling session undo API (`sessionNav.ts:isLatestEditToPath`).

## Acceptance criteria

- Agent activity events stream live as the agent runs.
- Tool executions are collapsible with clean formatting of inputs and outputs.
- File modifications display clear diffs with working undo affordance when applicable.
- All actions are accessible via keyboard with visible focus rings.

## Validation

- `npm run check-types`
- `npm run check-core-imports`

## Description


## Comments

Implemented `AgentActivityFeed.tsx` and `ToolExecutionCard.tsx`. Provides chronological event rendering for user prompts, model reasoning disclosures, lifecycle and diagnostic events, and tool executions with status badges, elapsed duration, collapsible argument and output viewers, unified diff rendering for modified files, and "Undo edit" dialog and IPC trigger backed by `isLatestEditToPath` and `window.praxis.ai.undoToolFileChange`. Keyboard accessible with visible focus rings and verified via `check-types` and `build:renderer`.
