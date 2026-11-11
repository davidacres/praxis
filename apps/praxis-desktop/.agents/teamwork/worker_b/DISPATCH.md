## 2026-11-08T16:13:08Z
You are assigned as Worker B to implement Milestone M2 (Workstream B: Electron Core Wiring in `crates/praxis-host` and `apps/praxis-desktop/main`).

Your Identity & Working Context:
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop (Repo root is /Users/daveacres/dev/tools/praxis)
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_b
- Original Request path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Plan path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/PROJECT.md
- Explorer Findings path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_b/handoff.md

Write Ownership:
You have exclusive write ownership of ONLY:
- `crates/praxis-host/src/context.rs`
- `apps/praxis-desktop/main/src/main/rustHostInstance.ts`
- `apps/praxis-desktop/main/src/main/settingsIpc.ts`
- `apps/praxis-desktop/main/src/main/folderIpc.ts`
- `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`
Do NOT write to files outside this set!

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task Objectives:
1. Read `ORIGINAL_REQUEST.md` and `explorer_survey_b/handoff.md`.
2. Follow Section 4 of `explorer_survey_b/handoff.md` to:
   - In `crates/praxis-host/src/context.rs`: add `folder:discoverPlans` handler and `plans:*` aliases (`plans:discoverPlans`, `plans:discoverPlanFolders`, `plans:parsePlanFolder`, `plans:readBoardConfig`, `plans:writeBoardConfig`, `plans:ensureFrontMatter`). Verify with `cargo check -p praxis-host`.
   - In `apps/praxis-desktop/main/src/main/rustHostInstance.ts`: add `settings:*`, `folder:*`, `plans:*`, and `folderService:*` to `DEFAULT_MIGRATED_CHANNELS`.
   - In `apps/praxis-desktop/main/src/main/settingsIpc.ts`: wrap `settings:get` and `settings:set` with `bridge.handleOrFallback(...)`.
   - In `apps/praxis-desktop/main/src/main/folderIpc.ts`: wrap `folder:discoverPlans` and register `folder:*` / `plans:*` handlers with `bridge.handleOrFallback(...)`.
   - In `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`: add unit tests asserting `settings:*`, `folder:*`, and `plans:*` are present in `DEFAULT_MIGRATED_CHANNELS` and route through `handleOrFallback`.
   - Run typechecks and tests:
     - `npm --prefix apps/praxis-desktop/main run check-types`
     - `npm --prefix apps/praxis-desktop/main run test:git`
     - `node scripts/cargo-workspace.mjs check`
3. Write your completion report to `/Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_b/handoff.md` including exact verification commands and results.
4. Notify orchestrator via send_message with a brief summary and handoff path.
