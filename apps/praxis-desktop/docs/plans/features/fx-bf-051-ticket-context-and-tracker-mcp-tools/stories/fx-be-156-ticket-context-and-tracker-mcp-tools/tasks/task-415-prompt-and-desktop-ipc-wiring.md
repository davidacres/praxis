---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-415
type: Task
status: Done
created: 2026-10-03
priority: High
story: FX-BE-156
---

# Agent prompt lifecycle directives and desktop IPC wiring

## Files and integration points

- `packages/core/src/ai/agentPrompt.ts`
- `packages/core/src/ai/agentTypes.ts`
- `apps/praxis-desktop/main/src/main/aiIpc.ts`
- `apps/praxis-desktop/main/src/main/trackerMcp.ts`
- `apps/praxis-desktop/main/src/main/deleteAgentSession.ts`

## Scope

- Add `ticketContext?: string` field to `AgentTaskDefinition`.
- Update `buildTaskSystemPrompt` in `packages/core/src/ai/agentPrompt.ts` to append `task.ticketContext` in both planning and non-planning modes.
- Implement desktop bridge in `apps/praxis-desktop/main/src/main/trackerMcp.ts`:
  - `trackerMcpServerForSession(sessionId, service, toolMode)`: Spins up an in-process MCP server instance for ACP sessions.
  - `disposeTrackerMcpForSession(sessionId)`: Disposes the MCP server when a session terminates or is deleted.
- Update `apps/praxis-desktop/main/src/main/aiIpc.ts`:
  - On `ai:delegate`, call `resolveTicketContext` if delegating an issue.
  - Pass the structured context into `AgentTaskDefinition.ticketContext`.
  - Pass `trackerMcpServerForSession` to `AcpAgentHost` via `mcpServersOption`.
  - Add Gateway tracker tools to `toolExtension` so non-ACP models can call `tracker_get_ticket`, `tracker_list_transitions`, `tracker_add_comment`, `tracker_update_ticket`, and `tracker_transition_ticket`.
- Update `apps/praxis-desktop/main/src/main/deleteAgentSession.ts` to ensure tracker MCP server resources are cleaned up on session deletion.

## Comments

### 2026-10-03 - Completed and Verified
- **Commit:** `aef97143`
- Wired `resolveTicketContext` into `aiIpc.ts` delegate handler.
- Configured MCP loopback server `praxis-tracker` on `AcpAgentHost` with prompt permissions.
- Added session cleanup hooks in `deleteAgentSession.ts`.
