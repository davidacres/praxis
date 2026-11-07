---
**Created:** 2026-11-07T21:22:00.750Z
id: FX-BE-198
type: Story
status: To Do
---

# Port AI Wire Providers, MCP Servers, ACP Host, and Team Chat

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Port the AI and agent runtime (`packages/core/src/ai/` and `apps/praxis-desktop/main/src/main/ai*.ts`) into `crates/praxis-ai`: streaming LLM wire clients (Anthropic, Gemini, OpenAI/Custom), token/cost usage ledger, internal and external MCP servers/clients with OAuth 2.1 PKCE, the ACP agent stdio supervisor (`acpAgentHost`), native skill/agent discovery, durable team chat coordination, and `praxis-gadget` parsing/repair.

## Tasks

- `TASK-524` — Port Anthropic, Gemini, and OpenAI streaming wire adapters
- `TASK-525` — Port internal MCP servers, OAuth PKCE flow, and ACP agent host
- `TASK-526` — Port durable team chat coordinator and praxis-gadget validator

## Acceptance Criteria

- All `ai/` unit test suites (`anthropicWire`, `geminiWire`, `customProviders`, `acpAgentHost`, `trackerMcpServer`, `browserMcpServer`, `readOnlyFilesMcp`, `teamChatCoordinator`, `gadgets`) pass in `cargo test -p praxis-ai`.
- `aiSessionMode.spec.ts`, `aiMcpServers.spec.ts`, `durableTeamChat.spec.ts`, and `aiUsageDashboard.spec.ts` pass.

## Dependencies

- `FX-BE-196`
- `FX-BE-197`

## Comments


