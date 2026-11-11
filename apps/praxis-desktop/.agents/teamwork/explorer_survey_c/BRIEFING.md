# BRIEFING — 2026-11-08T16:07:35Z

## Mission
Survey Workstream C requirements (FX-BE-198: TASK-525 & TASK-526) in `crates/praxis-ai`, comparing against TypeScript/core behaviors, identifying gaps, and producing an actionable implementation plan and handoff report.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, synthesizer
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_c
- Original parent: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Milestone: Workstream C Survey (FX-BE-198 / TASK-525 & TASK-526)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or modify source code
- Files for content delivery, messages for coordination
- Write only to `/Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_c`
- Output 5-component handoff.md

## Current Parent
- Conversation ID: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `crates/praxis-ai/` (Cargo.toml, src/lib.rs, src/usage_stats.rs, src/providers/)
  - `crates/praxis-core/src/config/mcp_servers.rs`
  - `crates/praxis-contracts/src/domain.rs`
  - `packages/core/src/ai/mcp/` (`mcpToolBridge.ts`, `mcpServerConfig.ts`)
  - `packages/core/src/ai/acp/` (`acpAgentHost.ts`, `acpClient.ts`)
  - `packages/core/src/ai/assistant/` (`teamChatStore.ts`, `assistantTypes.ts`, `teamChatTransitions.ts`, `teamChatCoordinator.ts`)
  - `apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts`
  - `packages/core/src/ai/gadgets/` (`contracts.ts`, `validation.ts`, `blockParser.ts`, `jsonRepair.ts`, `limits.ts`, `redaction.rs`, `fallback.ts`)
  - `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-198-ai-runtime-mcp-acp-and-team-chat/`
- **Key findings**:
  - `crates/praxis-ai` currently contains only TASK-524 (LLM wire adapters & usage ledger) with 105 passing tests.
  - TASK-525 (MCP server registry, stdio/HTTP tool transports, ACP stdio bridge) and TASK-526 (durable team chat message persistence, gadget validation & repair) are completely missing from `crates/praxis-ai`.
  - Full TypeScript architectures, contracts, and comprehensive unit tests exist in `packages/core/src/ai` and `main/adapters` to guide 100% parity implementation.
- **Unexplored areas**: None. Complete specification and plan prepared.

## Key Decisions Made
- Organized modular architecture for `crates/praxis-ai`: `src/mcp/`, `src/acp/`, `src/team_chat/`, `src/gadgets/`.
- Designed implementation steps, structs, enums, error types, and parity test suites.

## Artifact Index
- DISPATCH.md — dispatched instructions log
- BRIEFING.md — persistent working memory
- progress.md — liveness heartbeat
- handoff.md — final handoff report
