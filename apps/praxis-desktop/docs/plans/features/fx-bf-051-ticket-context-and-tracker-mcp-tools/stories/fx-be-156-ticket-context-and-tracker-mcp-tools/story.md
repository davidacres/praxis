---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-156
type: Story
status: Done
created: 2026-10-03
owner: Electron desktop app
feature: FX-BF-051
commits: [aef97143]
---

# Ticket context resolution, lifecycle directives, and tracker MCP server

## Impact

Engineers delegating tasks to AI agents ("Start AI") no longer need to manually copy descriptions, parent requirements, sibling constraints, or dependency tickets into the session. The agent starts with immediate full-context awareness and is armed with tracker tools (`tracker_get_ticket`, `tracker_list_transitions`, `tracker_add_comment`, `tracker_update_ticket`, `tracker_transition_ticket`) over a loopback MCP connection, enabling it to communicate milestone progress and update ticket status autonomously.

## Scope

- Resolution of complete ticket context from `IssueTrackerService`:
  - Active ticket: key, summary, issue type, status, priority, description, attachments, and full comment thread.
  - Parent context: parent feature / epic purpose, brief, and definition of done.
  - Sibling scope boundaries: sibling tasks under the same parent to demarcate what is in vs out of scope.
  - Dependencies: tickets declared in `dependsOn` or linked relations (`blocks`, `is blocked by`, `relates to`).
  - Available transitions: board workflow transitions permitted from the current status.
- Lifecycle directives in the agent prompt:
  - Phase 1 (Kickoff): Post an initial plan comment and transition ticket to "In Progress".
  - Phase 2 (Progress): Post milestone updates on key achievements or blockers.
  - Phase 3 (Completion): Post a concise summary of changes and transition ticket to "In Review" or "Done".
- `TrackerMcpServer` loopback MCP endpoint:
  - Exposes tracker tools to ACP CLI agents (Claude Code, Codex, Copilot CLI) via stdio JSON-RPC.
  - Provides mirror tools to Gateway API models.
  - Resolves workflow transitions flexibly by transition ID, target status name, or transition name.
- Desktop session integration and cleanup:
  - Binds MCP server instance per session and cleans up when the session is closed or deleted.

## Acceptance criteria

- Clicking "Start AI" on any ticket resolves its full hierarchy and injects structured markdown into the task prompt.
- E2E tests expecting the standard `- Key: <key>` format continue to pass without regression.
- ACP agents receive the `praxis-tracker` MCP server in their session initialization.
- Gateway agents receive equivalent tracker tools.
- `tracker_transition_ticket` successfully transitions tickets when passed natural status names like `"In Progress"` or synthetic backend IDs.
- Read-only sessions reject mutating tracker actions (`tracker_add_comment`, `tracker_update_ticket`, `tracker_transition_ticket`).

## Tasks

| Ref | Task | Status | Priority |
| --- | --- | --- | --- |
| TASK-413 | Core rich ticket context and graph resolution | Done | High |
| TASK-414 | Universal Tracker MCP Server and tool execution | Done | High |
| TASK-415 | Agent prompt lifecycle directives and desktop IPC wiring | Done | High |
| TASK-416 | Verification, tests, and AGENTS.md documentation | Done | Medium |

## Comments

### 2026-10-03 - Shipped and Verified
- **Commit:** `aef97143`
- **Details:**
  - Implemented `resolveTicketContext` in `packages/core/src/ai/ticketContext.ts`.
  - Implemented `TrackerMcpServer` in `packages/core/src/ai/trackerMcpServer.ts`.
  - Wired into `apps/praxis-desktop/main/src/main/aiIpc.ts`, `trackerMcp.ts`, and `deleteAgentSession.ts`.
  - Injected into prompt in `packages/core/src/ai/agentPrompt.ts`.
  - 100% test pass on `ticketContext.test.ts` and `trackerMcpServer.test.ts`.
  - Monorepo `check-types`, `build`, and core tests (1,372 passed) clean.
  - E2E tests `issueDetail.spec.ts` and `aiSessions.spec.ts` verified passing.

## Description


## Dependencies


