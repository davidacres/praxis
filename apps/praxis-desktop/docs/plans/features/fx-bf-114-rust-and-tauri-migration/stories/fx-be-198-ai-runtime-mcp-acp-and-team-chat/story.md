---
**Created:** 2026-11-07T21:22:00.750Z
id: FX-BE-198
type: Story
status: In Progress
---

# Port AI Wire Providers, MCP Servers, ACP Host, and Team Chat

**Status:** In Progress
**Type:** Story
**Priority:** High

## Description

Port the AI and agent runtime (`packages/core/src/ai/` and `apps/praxis-desktop/main/src/main/ai*.ts`) into `crates/praxis-ai`: streaming LLM wire clients (Anthropic, Gemini, OpenAI/Custom), token/cost usage ledger, internal and external MCP servers/clients with OAuth 2.1 PKCE, the ACP agent stdio supervisor (`acpAgentHost`), native skill/agent discovery, durable team chat coordination, and `praxis-gadget` parsing/repair.

### Execution Order & Parallelism (Wave 3 — Parallel with FX-BE-196 & FX-BE-197)

- **Story-Level Concurrency**: Starts immediately after `FX-BE-195` (Wave 2) in `crates/praxis-ai`, running in parallel with `FX-BE-196` and `FX-BE-197`.
- **Task-Level Concurrency**: `TASK-524` (LLM streaming wire adapters & usage ledger) has zero dependency on trackers or workflows and starts immediately after `FX-BE-195`. Once `TASK-524` finishes, `TASK-525` (MCP servers, OAuth PKCE & ACP host) and `TASK-526` (team chat coordinator & `praxis-gadget` validator) run in parallel.

## Tasks

- `TASK-524` (`High`, Sequential Step 1) — Port Anthropic, Gemini, and OpenAI streaming wire adapters
- `TASK-525` (`High`, Parallel Step 2A) — Port internal MCP servers, OAuth PKCE flow, and ACP agent host
- `TASK-526` (`High`, Parallel Step 2B) — Port durable team chat coordinator and praxis-gadget validator

## Acceptance Criteria

- All `ai/` unit test suites (`anthropicWire`, `geminiWire`, `customProviders`, `acpAgentHost`, `trackerMcpServer`, `browserMcpServer`, `readOnlyFilesMcp`, `teamChatCoordinator`, `gadgets`) pass in `cargo test -p praxis-ai`.
- `aiSessionMode.spec.ts`, `aiMcpServers.spec.ts`, `durableTeamChat.spec.ts`, and `aiUsageDashboard.spec.ts` pass.

## Dependencies

- `FX-BE-195`

## Comments


- 2026-11-08: Status corrected from To Do to In Progress. `TASK-524` has seven commits of provider and usage-ledger code in `crates/praxis-ai`. Drafts for `TASK-525` (`acp/`, `mcp/`) and `TASK-526` (`team_chat/`, `gadgets/`) exist in the working tree but are not committed. `cargo test -p praxis-ai` does not compile: `team_chat/transitions.rs` defines `mod tests` eight times (E0428). Fixing that is the first step of `FX-BE-203`/`TASK-534`. No `ai:*` channel is delegated to Rust yet, and that waits on `FX-BE-203`.
- 2026-11-08 (later): The `praxis-ai` test target compiles again (`TASK-534`), and the drafts for `TASK-525` and `TASK-526` are committed. 128 `praxis-ai` tests pass. Fixing them surfaced one port bug: the MCP truncation notice now groups thousands as `mcpToolBridge.ts` does. These drafts still have no line-by-line comparison with the TypeScript. `TASK-537`'s parity harness is where that happens before any `ai:*` cutover.
