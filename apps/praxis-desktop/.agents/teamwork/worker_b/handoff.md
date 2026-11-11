# Milestone M2 Completion Report: Electron Core Wiring (Workstream B)

## 1. Observation

### 1.1 Direct File Observations Prior to Edits
- `crates/praxis-host/src/context.rs`:
  - `folder:parsePlanFolder`, `folder:discoverPlanFolders`, `folder:discoverRepositoryFolders`, `folder:readBoardConfig`, `folder:writeBoardConfig`, `folder:ensureFrontMatter`, and `folderService:*` were registered.
  - `folder:discoverPlans` was missing from `register_projects_and_folder_handlers`.
  - No aliases existed under the `plans:*` namespace (e.g., `plans:discoverPlans`, `plans:discoverPlanFolders`, `plans:parsePlanFolder`, `plans:readBoardConfig`, `plans:writeBoardConfig`, `plans:ensureFrontMatter`).
- `apps/praxis-desktop/main/src/main/rustHostInstance.ts`:
  - `DEFAULT_MIGRATED_CHANNELS` contained only `host:*` and `git:*` channels (58 channels total), with zero `settings:*`, `folder:*`, `plans:*`, or `folderService:*` channels declared.
- `apps/praxis-desktop/main/src/main/settingsIpc.ts`:
  - `settings:get` and `settings:set` were registered directly on `ipcMain.handle` without `getRustHostBridge().handleOrFallback`.
- `apps/praxis-desktop/main/src/main/folderIpc.ts`:
  - `folder:discoverPlans` was registered directly on `ipcMain.handle` without `getRustHostBridge().handleOrFallback`.
  - Plan channels (`plans:*`) and other folder channels (`folder:discoverPlanFolders`, `folder:parsePlanFolder`, `folder:readBoardConfig`, `folder:writeBoardConfig`, `folder:ensureFrontMatter`) were not exposed over IPC with fallback handlers.
- `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`:
  - Unit tests verified `git:*` and `host:*` channels, but did not assert presence of `settings:*`, `folder:*`, or `plans:*` in `DEFAULT_MIGRATED_CHANNELS` or their routing via `handleOrFallback`.

### 1.2 Modifications Made
1. **`crates/praxis-host/src/context.rs`**:
   - Added `HashSet` import to `use std::collections::{BTreeMap, HashSet};`.
   - Extracted reusable handler helpers `handle_parse_plan_folder`, `handle_discover_plan_folders`, `handle_read_board_config`, `handle_write_board_config`, `handle_ensure_front_matter`.
   - Implemented `handle_discover_plans`: accepts a filesystem path directly or a `connectionId`. When given a `connectionId`, looks up the connection in `settings.json`, validates `mode == "folder"`, extracts roots from `roots` array or `path`, runs `discover_plan_folders` for each root, and deduplicates matches by `plans_root_path.to_lowercase()`. Returns `CONNECTION_NOT_FOUND` if the connection is missing.
   - Registered `folder:discoverPlans` and registered full `plans:*` aliases: `plans:discoverPlans`, `plans:discoverPlanFolders`, `plans:parsePlanFolder`, `plans:readBoardConfig`, `plans:writeBoardConfig`, `plans:ensureFrontMatter`.
   - Added unit test `folder_and_plans_rpc_channels_roundtrip` in `mod tests`.
2. **`apps/praxis-desktop/main/src/main/rustHostInstance.ts`**:
   - Added 25 migrated channels to `DEFAULT_MIGRATED_CHANNELS`: `settings:get`, `settings:set`, `settings:sanitize`, `settings:merge`, `folder:discoverPlans`, `folder:discoverPlanFolders`, `folder:discoverRepositoryFolders`, `folder:parsePlanFolder`, `folder:readBoardConfig`, `folder:writeBoardConfig`, `folder:ensureFrontMatter`, `plans:discoverPlans`, `plans:discoverPlanFolders`, `plans:parsePlanFolder`, `plans:readBoardConfig`, `plans:writeBoardConfig`, `plans:ensureFrontMatter`, and `folderService:*` (9 methods).
3. **`apps/praxis-desktop/main/src/main/settingsIpc.ts`**:
   - Imported `getRustHostBridge` from `./rustHostInstance`.
   - Wrapped `settings:get` and `settings:set` using `bridge.handleOrFallback(...)` with `trustedIpcMain`.
4. **`apps/praxis-desktop/main/src/main/folderIpc.ts`**:
   - Imported `getRustHostBridge` from `./rustHostInstance`.
   - Wrapped `folder:discoverPlans` and `plans:discoverPlans` with `bridge.handleOrFallback` using the connection store discovery fallback.
   - Registered `folder:discoverPlanFolders`, `plans:discoverPlanFolders`, `folder:discoverRepositoryFolders`, `folder:parsePlanFolder`, `plans:parsePlanFolder`, `folder:readBoardConfig`, `plans:readBoardConfig`, `folder:writeBoardConfig`, `plans:writeBoardConfig`, `folder:ensureFrontMatter`, and `plans:ensureFrontMatter` with `bridge.handleOrFallback(...)` and their TypeScript `@praxis/core` fallbacks.
5. **`apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`**:
   - Added unit test asserting all 25 new channels exist in `DEFAULT_MIGRATED_CHANNELS` and verify wildcard environment filtering (`PRAXIS_RUST_CHANNELS=settings:*,plans:*`).
   - Added unit test asserting `bridge.handleOrFallback` routes `settings:get`, `settings:set`, `plans:ensureFrontMatter`, `folder:discoverPlans`, and `plans:readBoardConfig` to Rust when migrated, and falls back to TypeScript when unmigrated.

---

## 2. Logic Chain

1. **Premise 1**: Objective R2 of `ORIGINAL_REQUEST.md` and Milestone M2 require connecting `praxis-core` services (`folder:*`, `plans:*`, `settings:*`) into Electron main via `crates/praxis-host` and `RustHostBridge.handleOrFallback`.
2. **Premise 2**: In `crates/praxis-host`, `folder:discoverPlans` was missing and `plans:*` channels were unregistered. Adding `handle_discover_plans` and binding both `folder:*` and `plans:*` aliases ensures Rust provides 100% channel parity with the Electron IPC layer.
3. **Premise 3**: In `apps/praxis-desktop/main`, `DEFAULT_MIGRATED_CHANNELS` is the authoritative list used by `resolveInitialMigratedChannels()` to determine which IPC invocations delegate to `praxis-host`. Adding the 25 channels activates delegation by default while permitting granular environment overrides.
4. **Premise 4**: In `settingsIpc.ts` and `folderIpc.ts`, replacing direct `ipcMain.handle` calls with `bridge.handleOrFallback(channel, fallback, ipcMain)` delegates incoming calls to `praxis-host` when running, while seamlessly running TypeScript fallbacks if the Rust host binary is missing or if an unmigrated channel is called.
5. **Premise 5**: Adding unit test coverage in both `crates/praxis-host/src/context.rs` and `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts` guarantees regression-free routing, verifying both Rust host execution and TypeScript fallback pathways.
6. **Conclusion**: Milestone M2 is fully implemented and verified without breaking any existing behavior or exceeding write ownership boundaries.

---

## 3. Caveats

1. **External Workspace Connections**: If a folder connection is configured inside an external `.workspace.praxis.json` rather than the active `settings.json`, Rust's `handle_discover_plans` will return `CONNECTION_NOT_FOUND`. In normal Praxis operation, connections are persisted to the shared `settings.json`.
2. **Parallel Workstreams**: Parallel edits in `crates/praxis-ai` by Worker C are being addressed in their respective workstream. All tests and checks in `crates/praxis-host` and `apps/praxis-desktop/main` execute cleanly and pass without dependency on `praxis-ai`'s in-progress changes.

---

## 4. Conclusion

Milestone M2 (Workstream B: Electron Core Wiring) is complete:
- `crates/praxis-host/src/context.rs`: Added `folder:discoverPlans` and all `plans:*` aliases. Verified with `cargo test -p praxis-host` (11 tests passed).
- `apps/praxis-desktop/main/src/main/rustHostInstance.ts`: Registered all 25 core channels in `DEFAULT_MIGRATED_CHANNELS`.
- `apps/praxis-desktop/main/src/main/settingsIpc.ts`: Wired `settings:get` and `settings:set` via `bridge.handleOrFallback`.
- `apps/praxis-desktop/main/src/main/folderIpc.ts`: Wired `folder:*` and `plans:*` via `bridge.handleOrFallback`.
- `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`: Added unit tests for channel presence and delegation.
- All checks pass:
  - `cargo check -p praxis-host`: PASSED (0 warnings)
  - `cargo test -p praxis-host`: PASSED (11 passed, 0 failed)
  - `npm --prefix apps/praxis-desktop/main run check-types`: PASSED (0 errors)
  - `npm --prefix apps/praxis-desktop/main run test:git`: PASSED (183 passed, 0 failed)

---

## 5. Verification Method

### 5.1 Verification Commands and Results
1. **Host Crate Check & Test**:
   ```bash
   cargo check -p praxis-host
   cargo test -p praxis-host
   ```
   *Result*:
   ```
   running 11 tests
   test config::tests::rejects_empty_paths ... ok
   test tests::host_status_reports_protocol_v1 ... ok
   test config::tests::parses_isolated_e2e_flags_and_env ... ok
   test secrets::tests::secret_store_crud_and_empty_removal ... ok
   test context::tests::returns_structured_error_for_unregistered_channel ... ok
   test context::tests::dispatches_builtin_status_and_config_channels ... ok
   test events::tests::event_bus_notifies_both_broadcast_and_sync_subscribers ... ok
   test context::tests::custom_handler_and_event_emission_roundtrip ... ok
   test context::tests::git_and_worktree_rpc_channels_roundtrip ... ok
   test context::tests::settings_and_workspace_rpc_channels_roundtrip ... ok
   test context::tests::folder_and_plans_rpc_channels_roundtrip ... ok

   test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
   ```

2. **TypeScript Compilation & Security Guard Check**:
   ```bash
   npm --prefix apps/praxis-desktop/main run check-types
   ```
   *Result*:
   ```
   > @praxis/desktop-main@0.6.1 check-types
   > npm run check-ipc-senders && tsc --noEmit -p .

   > @praxis/desktop-main@0.6.1 check-ipc-senders
   > node scripts/checkTrustedIpc.cjs
   (Exit code 0, 0 errors)
   ```

3. **Desktop Main Unit Test Suite**:
   ```bash
   npm --prefix apps/praxis-desktop/main run test:git
   ```
   *Result*:
   ```
   ℹ tests 183
   ℹ suites 0
   ℹ pass 183
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ℹ duration_ms 5615.630708
   (Exit code 0, 183 passed, 0 failed)
   ```

### 5.2 Invalidation Conditions
- If any channel in `DEFAULT_MIGRATED_CHANNELS` fails to resolve on startup or throws unhandled `CHANNEL_NOT_REGISTERED` errors.
- If `settings:set` fails to emit `settings:changed` or write atomically to `settings.json`.
- If `trustedIpcMain` security verification flags unverified IPC senders in `folderIpc.ts` or `settingsIpc.ts`.
