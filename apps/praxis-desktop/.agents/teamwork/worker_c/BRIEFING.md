# BRIEFING — 2026-11-08T16:13:40Z

## Mission
Implement Milestone M3 (Workstream C: AI MCP / ACP Runtime, Durable Team Chat, and Gadgets in `crates/praxis-ai`).

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_c
- Original parent: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Milestone: M3 (Workstream C)

## 🔒 Key Constraints
- Write ownership restricted strictly to:
  - `crates/praxis-ai/Cargo.toml`
  - `crates/praxis-ai/src/lib.rs`
  - `crates/praxis-ai/src/mcp/**`
  - `crates/praxis-ai/src/acp/**`
  - `crates/praxis-ai/src/team_chat/**`
  - `crates/praxis-ai/src/gadgets/**`
- No writing outside this set!
- Genuine implementation, no hardcoded cheating, no facades.
- Must verify with `cargo test -p praxis-ai` and `cargo clippy -p praxis-ai --all-targets --all-features -- -D warnings`.

## Current Parent
- Conversation ID: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Updated: 2026-11-08T16:13:40Z

## Task Summary
- **What to build**: Full implementation of MCP runtime, ACP agent host and process supervisor, Durable Team Chat with hash-chained transitions and atomic persistence, and Gadgets system in `crates/praxis-ai`.
- **Success criteria**: All types, services, transports, repositories, parsers, and unit tests passing, clippy clean with `-D warnings`.
- **Interface contracts**: `explorer_survey_c/handoff.md`, `ORIGINAL_REQUEST.md`.
- **Code layout**: `crates/praxis-ai/src/{mcp,acp,team_chat,gadgets}`.

## Change Tracker
- **Files modified**: None yet.
- **Build status**: Not run yet.
- **Pending issues**: Initial implementation pending.

## Quality Status
- **Build/test result**: Pending.
- **Lint status**: Pending.
- **Tests added/modified**: Pending.

## Loaded Skills
- None explicitly requested to copy.

## Key Decisions Made
- Initializing workstream C according to explorer handoff.

## Artifact Index
- `DISPATCH.md` — assignment dispatch
- `BRIEFING.md` — persistent memory
- `progress.md` — heartbeat and task progress
- `handoff.md` — final completion report (to be written)
