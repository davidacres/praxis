---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-407
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# `usePageAssistantContext` hook and surface integrations for Board, Issue Detail, and Git

## Files and integration points

- `apps/praxis-desktop/renderer/src/assistant/AssistantContextRegistry.tsx` (new): Context provider and `useRegisterPageAssistantContext` hook.
- `apps/praxis-desktop/renderer/src/board/BoardView.tsx`: Registers board status, active filter, visible ticket count, and suggested prompts.
- `apps/praxis-desktop/renderer/src/issues/IssueDetail.tsx`: Registers ticket details, acceptance criteria, comments, and review prompts.
- `apps/praxis-desktop/renderer/src/git/GitChangesPage.tsx`: Registers staged/unstaged file list and diff summaries.

## Implementation details

- Context hook contract:
  - Takes `{ pageType, title, summary, data, suggestedPrompts, onApplyAction }`.
  - When the component mounts, registers itself with the assistant store; on unmount, unregisters cleanly.
- Board View payload:
  - Formats column names, issue keys, summaries, and statuses into a compact summary structure.
  - Suggests: *"Summarize blocked tickets"*, *"Suggest backlog grooming priorities"*.
- Issue Detail payload:
  - Serializes issue summary, status, description, and comments.
  - Suggests: *"Review acceptance criteria"*, *"Suggest unit and edge test cases"*, *"Check security considerations"*.
- Git Changes payload:
  - Summarizes modified files and diff hunks.
  - Suggests: *"Draft conventional commit message"*, *"Scan diff for leaked secrets or console logs"*.

## Testing and verification criteria

- Navigating between Board, Issue Detail, and Git Changes updates the Assistant's context badge and suggestion chips immediately.
- Sending a message on an issue screen includes the issue context in the turn prompt.
