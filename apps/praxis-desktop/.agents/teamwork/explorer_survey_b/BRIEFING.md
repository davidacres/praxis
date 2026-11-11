# BRIEFING — 2026-11-08T16:11:10Z

## Mission
Explore and analyze Workstream B: wiring `praxis-core` services into Electron (`folder:*`, `plans:*`, `settings:*`) via `crates/praxis-host` and `apps/praxis-desktop/main/src/main/rustHostInstance.ts` (`RustHostBridge.handleOrFallback`).

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis, technical architecture plan
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_b
- Original parent: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Milestone: Workstream B Exploration & Analysis

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Strictly observe file workspace conventions: write only to `.agents/teamwork/explorer_survey_b/`
- Deeply inspect `crates/praxis-core`, `crates/praxis-host`, and `apps/praxis-desktop/main`
- Prepare concrete, step-by-step implementation plan for worker

## Current Parent
- Conversation ID: 8a3effd9-ae4a-43a7-85d0-28e432b24c2d
- Updated: 2026-11-08T16:11:10Z

## Investigation State
- **Explored paths**:
  - `crates/praxis-core/src/config/app_settings.rs`
  - `crates/praxis-core/src/folder/` (`markdown_plan_parser.rs`, `board_config_file.rs`, `markdown_template.rs`, `folder_fs.rs`)
  - `crates/praxis-trackers/src/folder_service.rs`
  - `crates/praxis-host/src/context.rs`, `lib.rs`, `bin/praxis-host.rs`
  - `crates/praxis-contracts/src/domain.rs`, `ipc.rs`
  - `apps/praxis-desktop/main/src/main/rustHostInstance.ts`, `rustHostBridge.ts`, `rustHostBridge.test.ts`
  - `apps/praxis-desktop/main/src/main/folderIpc.ts`, `settingsIpc.ts`, `gitIpc.ts`, `serviceRegistry.ts`
  - `apps/praxis-desktop/main/e2e/folder.spec.ts`, `settingsReset.spec.ts`, `newIssue.spec.ts`, `launchTestApp.ts`
- **Key findings**:
  - Rust core implementations of `AppSettings`, `FolderService`, plan front-matter parser, and board synthesizer already exist and have verified parity tests in `rustHostBridge.test.ts`.
  - `crates/praxis-host` already registers `settings:get`, `settings:set`, `folder:parsePlanFolder`, `folder:readBoardConfig`, `folder:writeBoardConfig`, `folder:ensureFrontMatter`, `folder:discoverPlanFolders`, and `folderService:*`.
  - Electron main currently registers `settings:get`, `settings:set` and `folder:discoverPlans` via direct `ipcMain.handle`, bypassing `RustHostBridge`.
  - `DEFAULT_MIGRATED_CHANNELS` in `rustHostInstance.ts` only contains `host:*` and `git:*` channels; needs expansion to include `folder:*`, `plans:*`, `settings:*`, and `folderService:*`.
  - `crates/praxis-host` needs `folder:discoverPlans` handler and `plans:*` aliases to complete full coverage.
- **Unexplored areas**: None. Full end-to-end trace completed.

## Key Decisions Made
- Structuring handoff.md following the 5-component protocol: Observation, Logic Chain, Caveats, Conclusion, Verification Method.
- Detailed step-by-step Worker guide provided in Conclusion.

## Artifact Index
- DISPATCH.md — incoming dispatch instructions
- progress.md — liveness heartbeat and step tracking
- BRIEFING.md — persistent situational awareness
- handoff.md — final comprehensive report
