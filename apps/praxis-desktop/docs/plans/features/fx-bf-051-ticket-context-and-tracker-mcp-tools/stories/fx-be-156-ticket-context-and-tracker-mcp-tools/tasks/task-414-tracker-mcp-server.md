---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-414
type: Task
status: Done
created: 2026-10-03
priority: High
story: FX-BE-156
---

# Universal Tracker MCP Server and tool execution

## Files and integration points

- `packages/core/src/ai/trackerMcpServer.ts`
- `packages/core/src/ai/trackerMcpServer.test.ts`
- `packages/core/src/index.ts`

## Scope

- Implement `TrackerMcpServer` conforming to the Model Context Protocol (MCP) in `@praxis/core`.
- Provide tracker tools:
  - `tracker_get_ticket`: Fetch full ticket details, description, fields, and comments.
  - `tracker_list_transitions`: Retrieve valid workflow status transitions for a ticket.
  - `tracker_add_comment`: Post a markdown comment to a ticket.
  - `tracker_update_ticket`: Edit summary or description.
  - `tracker_transition_ticket`: Transition workflow status.
- Implement flexible transition matching:
  - Match by transition ID directly.
  - Match by target status name (`toStatus` case-insensitive).
  - Match by transition name (`name` case-insensitive).
- Guard mutating operations when `readOnly: true` is set, returning actionable error messages.
- Export `createTrackerMcpServer` and tool schemas for reuse across CLI ACP subagents and Gateway API tool definitions.

## Comments

### 2026-10-03 - Completed and Verified
- **Commit:** `aef97143`
- Implemented `TrackerMcpServer` with stdio/message transport support in `packages/core/src/ai/trackerMcpServer.ts`.
- Added unit tests in `packages/core/src/ai/trackerMcpServer.test.ts` testing tool enumeration, tool execution, fuzzy transition matching, and read-only rejection.
- All unit tests pass cleanly.

## Description


## Dependencies


