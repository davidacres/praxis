---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-409
type: Task
status: Complete
created: 2026-10-03
priority: High
---

# Interactive action proposals with 1-click apply and ACP coding session delegation

## Files and integration points

- `apps/praxis-desktop/renderer/src/assistant/AssistantActionCard.tsx` (new): Renders proposed modifications and execution triggers.
- `apps/praxis-desktop/renderer/src/app/App.tsx`: Handles `onDelegateToSession` handoff from the assistant into a new autonomous ACP agent session.
- `apps/praxis-desktop/renderer/src/assistant/assistantActions.ts` (new): Dispatch handlers for ticket update, workflow update, and session delegation.

## Implementation details

- Supported proposal actions:
  - `update-ticket`: Updates ticket description or acceptance criteria; requires user click on `[Apply to Ticket]`.
  - `create-subtask`: Creates a new child task file linked to the current issue; requires user confirmation.
  - `update-workflow`: Directly updates the active workflow definition in the designer.
- "Delegate to Coding Session" (ACP Handoff):
  - When a user asks the team to implement the plan or write code:
  - An action card renders: `[⚡ Open as Coding Session in Praxis]`.
  - Clicking this switches navigation to a new ACP agent session (`navigate({ newSession: true })`), pre-populating the session's prompt with the summary, persona recommendations, and ticket context.

## Testing and verification criteria

- Clicking an action card button successfully executes the registered handler with visual confirmation.
- Clicking "Open as Coding Session" opens the New Session composer with pre-seeded task prompt and project context.

## Description


## Dependencies



## Comments


