# BRIEFING — 2026-11-08T16:27:30Z

## Mission
Orchestrate execution of Praxis Rust migration across three workstreams: Workstream A (Workflows), Workstream B (Electron Core Wiring), and Workstream C (AI MCP/ACP Runtime).

## 🔒 My Identity
- Archetype: orchestrator
- Roles: orchestrator, user_liaison, human_reporter, successor
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1
- Original parent: parent
- Original parent conversation ID: 480efe3d-59ce-46aa-a229-d7dfeb5c85dd

## 🔒 My Workflow
- **Pattern**: Project Orchestrator
- **Scope document**: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/PROJECT.md
1. **Decompose**: Decompose request into 3 parallel workstreams (Workstream A: Workflows in crates/praxis-workflows, Workstream B: Electron Core Wiring in crates/praxis-host & rustHostInstance.ts, Workstream C: AI MCP/ACP Runtime in crates/praxis-ai) plus survey and E2E verification.
2. **Dispatch & Execute** (pick ONE):
   - **Direct (iteration loop)**: For each workstream/milestone: Explorer -> Worker -> Reviewer -> Challenger -> Auditor -> Gate
3. **On failure** (in this order):
   - Retry: nudge stuck agent or re-send task
   - Replace: spawn fresh agent with partial progress
   - Skip: proceed without (only if non-critical)
   - Redistribute: split stuck agent's remaining work
   - Redesign: re-partition decomposition
   - Escalate: report to parent (sub-orchestrators only, last resort)
4. **Succession**: At 16 spawns, write handoff.md, spawn successor
- **Work items**:
  1. Survey scope and existing codebase [done]
  2. Workstream A (Workflows FX-BE-197) [done]
  3. Workstream B (Electron Core Wiring) [done]
  4. Workstream C (AI MCP/ACP Runtime FX-BE-198) [in-progress]
  5. Final verification & integration tests [pending]
- **Current phase**: 2 (Execution)
- **Current focus**: Implementation of Milestone M3 (M1 and M2 completed)

## 🔒 Key Constraints
- NEVER write, modify, or create source code files directly.
- NEVER run build/test commands yourself — require workers to do so.
- NEVER investigate or explore the problem at the code level — dispatch Explorers for technical investigation.
- You MAY use file-editing tools ONLY for metadata/state files (.md) in your .agents/teamwork/ folder.
- Hard audit veto on integrity violations.
- Always include ORIGINAL_REQUEST.md path in every dispatch.
- Never reuse a subagent after it has delivered its handoff — always spawn fresh.

## Current Parent
- Conversation ID: 480efe3d-59ce-46aa-a229-d7dfeb5c85dd
- Updated: not yet

## Key Decisions Made
- Decompose into 3 parallel workstreams matching requirements R1, R2, R3.
- All 3 survey Explorers delivered handoff reports with detailed architecture and technical plans.
- Dispatched 3 Workers in parallel with strictly segregated write ownership.
- Worker A completed Milestone M1 (`crates/praxis-workflows`): `cron_scheduler.rs` implemented with 12 unit tests, 280/280 tests pass, clippy clean.
- Worker B completed Milestone M2 (`crates/praxis-host` & Electron wiring): `folder:discoverPlans` and `plans:*` implemented, 25 migrated channels registered, `handleOrFallback` wired in `settingsIpc.ts` and `folderIpc.ts`, `cargo test -p praxis-host` passes (11/11), `check-types` clean, `test:git` passes (183/183).

## Team Roster
| Agent | Type | Work Item | Status | Conv ID |
|-------|------|-----------|--------|---------|
| explorer_survey_a | teamwork_explorer | Workstream A Survey (Workflows) | completed | e4521361-03d5-4746-8be8-79c0b943c8e6 |
| explorer_survey_b | teamwork_explorer | Workstream B Survey (Electron Wiring) | completed | 1bd5581c-fef4-443b-9240-ceb2151ccf36 |
| explorer_survey_c | teamwork_explorer | Workstream C Survey (AI MCP Runtime) | completed | ef56b70e-b3f4-4b8e-980b-c5ed4210a5bf |
| worker_a | teamwork_worker | Milestone M1 Implementation (Workflows) | completed | 7d192d87-2406-4054-acf7-556189f11ad5 |
| worker_b | teamwork_worker | Milestone M2 Implementation (Electron Wiring) | completed | bb1ab557-5d51-431a-8129-9a693c722799 |
| worker_c | teamwork_worker | Milestone M3 Implementation (AI Runtime) | in-progress | 5142aea7-1a7a-4a4a-b484-25ae2ed4d8d7 |

## Succession Status
- Succession required: no
- Spawn count: 6 / 16
- Pending subagents: 5142aea7-1a7a-4a4a-b484-25ae2ed4d8d7
- Predecessor: none
- Successor spawned: not yet spawned
- Successor generation: none
- Successor state folder: none

## Active Timers
- Heartbeat cron: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d/task-14
- Safety timer: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d/task-128
- On succession: kill all timers before spawning successor
- On context truncation: handle timers as step 4 of the State Recovery section of your prompt says

## Artifact Index
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md — Verbatim user request
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/DISPATCH.md — Orchestrator dispatch record
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/progress.md — Progress & liveness heartbeat
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/PROJECT.md — Global project plan and feature inventory
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_a/handoff.md — Explorer A survey report
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_b/handoff.md — Explorer B survey report
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_c/handoff.md — Explorer C survey report
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_a/handoff.md — Worker A completion report
- /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_b/handoff.md — Worker B completion report
