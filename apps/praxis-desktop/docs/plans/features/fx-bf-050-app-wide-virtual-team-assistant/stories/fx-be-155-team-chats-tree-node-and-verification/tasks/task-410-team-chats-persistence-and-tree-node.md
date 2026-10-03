---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-410
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Team chat persistence and Project tree `Team Chats` sidebar node

## Files and integration points

- `packages/core/src/assistant/teamChatStore.ts` (new): Durable storage for `TeamChatRecord`s.
- `apps/praxis-desktop/main/src/main/assistantIpc.ts`: CRUD IPC handlers for team chat sessions (`assistant:listChats`, `assistant:getChat`, `assistant:deleteChat`, `assistant:renameChat`).
- `apps/praxis-desktop/renderer/src/app/Sidebar.tsx`: Renders the `Team Chats` expandable tree section under projects.

## Implementation details

- `TeamChatRecord` schema:
  - `id: string`, `projectId: string`, `title: string`, `issueKey?: string`, `createdAt: string`, `updatedAt: string`, `messages: AssistantMessage[]`.
- Tree node presentation in `Sidebar.tsx`:
  - Placed alongside `Board`, `Documents`, and `Sessions`.
  - Icon: `<Icon name="chats" />` or `<Icon name="sparkles" />`.
  - Shows active chat count badge.
  - Lists chats with title and optional issue tag pill (e.g. `[FX-102]`).
  - Row action: Delete chat button (`<Icon name="trash" />`).
  - Quick action: New chat button (`<Icon name="plus" />`).
- Navigation:
  - Selecting a chat opens the Assistant panel with that thread active.

## Testing and verification criteria

- Creating a new chat adds an entry to the sidebar tree immediately.
- Restarting the app preserves the chat history and sidebar list.
- Deleting a chat cleans up the record and resets the active assistant view.
