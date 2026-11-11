## 2026-11-08T16:13:19Z
You are assigned as Worker C to implement Milestone M3 (Workstream C: AI MCP / ACP Runtime, Durable Team Chat, and Gadgets in `crates/praxis-ai`).

Your Identity & Working Context:
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop (Repo root is /Users/daveacres/dev/tools/praxis)
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_c
- Original Request path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Plan path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/PROJECT.md
- Explorer Findings path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_c/handoff.md

Write Ownership:
You have exclusive write ownership of ONLY:
- `crates/praxis-ai/Cargo.toml`
- `crates/praxis-ai/src/lib.rs`
- `crates/praxis-ai/src/mcp/**`
- `crates/praxis-ai/src/acp/**`
- `crates/praxis-ai/src/team_chat/**`
- `crates/praxis-ai/src/gadgets/**`
Do NOT write to files outside this set!

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task Objectives:
1. Read `ORIGINAL_REQUEST.md` and `explorer_survey_c/handoff.md`.
2. Follow Section 4 of `explorer_survey_c/handoff.md` to:
   - In `crates/praxis-ai/Cargo.toml`: add workspace dependencies (`sha2`, `sha1`, `uuid`, `url`).
   - Implement TASK-525:
     - `src/mcp/`: JSON-RPC 2.0 types, stdio & HTTP tool transports, McpClientPool, tool namespacing (64-char clamp, SHA-1 suffix), output truncation (60,000 char clamp), built-in servers (`read_only_files`, `tracker`, `coordination`), McpServerRegistry.
     - `src/acp/`: ACP protocol schemas, stdio process supervisor, AcpAgentHost with tool permission gating (`ReadOnly`, `ProjectOnly`, `Full`), and sandboxed FS tools.
   - Implement TASK-526:
     - `src/team_chat/`: domain types, deterministic canonical SHA-256 transitions with turn idempotency, epoch crash recovery, and `FileTeamChatRepository` with atomic temp-file + fsync + rename persistence.
     - `src/gadgets/`: version 1 envelope contracts, 12 gadget kinds, 128KB envelope limit, secret regex redaction (`[redacted]`), lenient JSON string quote repair, block parser for ````praxis-gadget ... ````, and action validation.
   - Add comprehensive unit tests for all modules in `crates/praxis-ai`.
   - Verify `cargo test -p praxis-ai` passes completely.
   - Verify `cargo clippy -p praxis-ai --all-targets --all-features -- -D warnings` is clean.
3. Write your completion report to `/Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_c/handoff.md` including exact verification commands and results.
4. Notify orchestrator via send_message with a brief summary and handoff path.
