---
**Created:** 2026-11-07T21:22:00.754Z
id: TASK-525
type: Task
status: To Do
---

# Port internal MCP servers, OAuth PKCE flow, and ACP agent host

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port the built-in MCP servers (`trackerMcpServer`, `browserMcpServer`, `readOnlyFilesMcp`, `coordinationMcp`, and `codeIntelligence/mcpBridge`), external MCP client factory with OAuth 2.1 PKCE (`mcpOAuthManager.ts`), and the ACP JSON-RPC 2.0 stdio supervisor (`acpAgentHost.ts`) plus native agent/skill discovery (`agentRuntime/nativeSources.ts`) into `crates/praxis-ai`.

## Acceptance Criteria

- `acpAgentHost`, `trackerMcpServer`, `browserMcpServer`, `readOnlyFilesMcp`, `coordination`, and `nativeSources` unit tests pass in `cargo test -p praxis-ai`.
- `aiMcpServers.spec.ts` passes.

## Dependencies

- `TASK-518`
- `TASK-524`

## Comments


