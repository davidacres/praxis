---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-408
type: Task
status: Complete
created: 2026-10-03
priority: Medium
---

# Workflow Designer assistant migration to unified assistant with mutation action

## Files and integration points

- `apps/praxis-desktop/renderer/src/workflows/WorkflowDesignerPage.tsx`: Removes embedded `WorkflowAssistantPopover` and registers with the global assistant via `useRegisterPageAssistantContext`.
- `apps/praxis-desktop/renderer/src/workflows/WorkflowAssistantPopover.tsx`: Deprecated and pruned once global assistant covers its capabilities.
- `apps/praxis-desktop/main/src/main/assistantIpc.ts`: Handles workflow validation and returns validated workflow definitions when the assistant updates a workflow.

## Implementation details

- `WorkflowDesignerPage` provides:
  - Current normalized `WorkflowDefinition`.
  - Live validation diagnostics (`errors`, `warnings`).
  - `onApplyAction`: Callback that applies proposed workflow changes via `onWorkflowChange`.
- Prompts suggested:
  - *"Verify this workflow for policy compliance"*, *"Add a QA test gate before approval"*, *"Explain this workflow"*.
- When a user asks for a workflow modification, the Tech Lead persona returns a proposed action with the updated workflow definition; the user sees a `[Apply Workflow Changes]` button which invokes `onApplyAction`.

## Testing and verification criteria

- Opening Workflow Designer registers context and shows workflow suggestions in the global assistant.
- Requesting a valid workflow modification produces an interactive Action Card; clicking Apply updates the canvas and marks the definition dirty/saved.
- Pruning `WorkflowAssistantPopover` leaves zero unused CSS or dead imports.

## Description


## Dependencies



## Comments


