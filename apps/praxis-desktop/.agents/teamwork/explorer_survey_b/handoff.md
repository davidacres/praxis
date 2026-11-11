# Handoff Report: Electron Core Wiring Exploration (Workstream B)

## 1. Observation

### 1.1 Existing Rust Core Implementations
- **`AppSettings` Store & Sanitization**:
  - `crates/praxis-core/src/config/app_settings.rs:2457-2505`: `SharedSettingsStore` targets the shared `settings.json` file.
  - `SharedSettingsStore.read(&self) -> AppSettings`: Reads disk JSON and sanitizes via `sanitize_app_settings`.
  - `SharedSettingsStore.write(&self, patch: &Value) -> io::Result<AppSettings>`: Validates mobile subnet CIDRs (`Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.`), merges patch over baseline, sanitizes, and writes atomically using temp file + atomic rename.
  - Verified in `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts:282-323`: `settings:get` and complex `settings:set` match TypeScript `@praxis/core` outputs byte-for-byte.
- **Front-Matter Parser & Templates**:
  - `crates/praxis-core/src/folder/markdown_plan_parser.rs:1033`: `discover_plan_folders(selected_root: &str) -> Result<Vec<IdentifiedPlanFolder>, String>` recursively scans directory trees, skipping checkout directories and hidden paths, detecting `features/` folders and plans roots.
  - `crates/praxis-core/src/folder/markdown_plan_parser.rs`: `parse_plan_folder` extracts front-matter (`**Status:**`, `**Type:**`, `**Priority:**`, `**Parent:**`, `**Assignee:**`, `## Comments`, `## Description`), computes feature rollups, and parses dependency graphs.
  - `crates/praxis-core/src/folder/markdown_template.rs:645`: `ensure_front_matter(content: &str, issue_type: IssueType) -> String` injects missing front-matter blocks idempotently without destroying existing markdown text.
  - `crates/praxis-core/src/folder/board_config_file.rs`: `read_board_config_file` and `write_board_config_file` manage `board.praxis.json` per plans root.
  - Verified in `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts:503-532`: Real plans folder (`apps/praxis-desktop/docs/plans`) parsed by Rust matches TypeScript `parsePlanFolder` and `resolvePlanDependencyKeys` exactly.
- **FolderService & Board Synthesizer**:
  - `crates/praxis-trackers/src/folder_service.rs:339`: `FolderService` implements complete markdown issue tracking:
    - `get_boards(&self, filters: &BoardFilters) -> Result<Vec<Board>, String>` (synthesizes `Board` objects from configured roots)
    - `get_board_details(&self, board: &Board) -> Result<BoardDetails, String>` (synthesizes columns according to workflow categories and maps issue cards to columns using `resolve_status`)
    - `get_issues`, `get_issue`, `get_transitions`, `create_issue`, `update_issue`, `transition_issue`, `add_comment`, `sync_board_config_to_folder`.

### 1.2 `crates/praxis-host` RPC Channels
- `crates/praxis-host/src/bin/praxis-host.rs:40-79`: The daemon runs via `--stdio`, exchanging single-line NDJSON requests (`RustRpcRequest`) and responses (`RustRpcResponse`) over stdin/stdout, and pushes domain events (`HostWireFrame::Event`) when `HostEventBus` emits.
- `crates/praxis-host/src/context.rs:200-865`: Currently registered built-in handlers:
  - Settings:
    - `settings:get` (line 311)
    - `settings:set` (line 318, emits `settings:changed`)
    - `settings:sanitize` (line 334)
    - `settings:merge` (line 342)
  - Folder & Plans:
    - `folder:parsePlanFolder` (line 540)
    - `folder:discoverPlanFolders` (line 571)
    - `folder:discoverRepositoryFolders` (line 586)
    - `folder:readBoardConfig` (line 601)
    - `folder:writeBoardConfig` (line 617)
    - `folder:ensureFrontMatter` (line 641)
  - FolderService:
    - `folderService:getBoards` (line 648)
    - `folderService:getBoardDetails` (line 663)
    - `folderService:getIssues` (line 684)
    - `folderService:getIssue` (line 720)
    - `folderService:getTransitions` (line 740)
    - `folderService:createIssue` (line 760)
    - `folderService:updateIssue` (line 783)
    - `folderService:transitionIssue` (line 814)
    - `folderService:addComment` (line 840)
- Notice: `crates/praxis-host` does NOT currently register `folder:discoverPlans` (the Electron channel that accepts `connectionId`), nor does it register aliases under the `plans:*` namespace (e.g. `plans:discoverPlans`, `plans:parsePlanFolder`, `plans:ensureFrontMatter`, `plans:readBoardConfig`, `plans:writeBoardConfig`).

### 1.3 Electron Main Process (`apps/praxis-desktop/main`)
- **`rustHostInstance.ts:14-58`**:
  `DEFAULT_MIGRATED_CHANNELS` currently contains ONLY `host:*` (10 channels) and `git:*` (48 channels). It has ZERO `folder:*`, `plans:*`, or `settings:*` channels listed.
- **`rustHostInstance.ts:65-87`**:
  `resolveInitialMigratedChannels()` filters channels based on `process.env.PRAXIS_RUST_CHANNELS`. When given a wildcard prefix like `folder:*`, `plans:*`, or `settings:*`, it filters against `DEFAULT_MIGRATED_CHANNELS`. Because these channels are missing from `DEFAULT_MIGRATED_CHANNELS`, setting `PRAXIS_RUST_CHANNELS=folder:*` or `settings:*` yields an empty array.
- **`rustHostBridge.ts:414-436`**:
  `RustHostBridge.handleOrFallback` handles channel delegation:
  ```ts
  ipcTarget.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (this.migrated.has(channel)) {
      try {
        return await this.invoke<TResult>(channel, ...args);
      } catch (error) {
        if (error instanceof RustHostRpcError && error.code !== 'CHANNEL_NOT_REGISTERED') {
          throw error;
        }
        console.warn(`[rustHostBridge] Falling back to TypeScript for channel '${channel}':`, error);
        return fallback(event, ...(args as TArgs));
      }
    }
    return fallback(event, ...(args as TArgs));
  });
  ```
- **`settingsIpc.ts:37-42`**:
  ```ts
  ipcMain.handle('settings:get', async () => getSettingsBackend().read());
  ipcMain.handle('settings:set', async (_event, patch: AppSettingsPatch) => {
    if (patch.mobileAccess?.allowedSubnets?.some(value => normalizeMobileSubnet(value) === undefined))
      throw new Error('Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.');
    return getSettingsBackend().write(patch);
  });
  ```
  These are registered directly on `trustedIpcMain`, bypassing `getRustHostBridge().handleOrFallback`.
- **`folderIpc.ts:7-29`**:
  ```ts
  ipcMain.handle('folder:discoverPlans', async (_event, connectionId: string) => {
    const connection = getConnectionStore().getConnection(connectionId);
    ...
  });
  ```
  This is also registered directly on `trustedIpcMain`, bypassing `getRustHostBridge().handleOrFallback`.

---

## 2. Logic Chain

1. **Premise 1**: Workstream B requires connecting `praxis-core` services (`folder:*`, `plans:*`, `settings:*`) from `crates/praxis-core` to `crates/praxis-host`, and registering them in `apps/praxis-desktop/main` using `RustHostBridge.handleOrFallback`.
2. **Premise 2**: In `crates/praxis-host`, handlers for `settings:get`, `settings:set`, `settings:sanitize`, `settings:merge`, `folder:parsePlanFolder`, `folder:discoverPlanFolders`, `folder:readBoardConfig`, `folder:writeBoardConfig`, `folder:ensureFrontMatter`, and `folderService:*` already exist.
3. **Premise 3**: However, `crates/praxis-host` lacks `folder:discoverPlans` (which takes `connectionId` or root paths and returns `IdentifiedPlanFolder[]`) and lacks `plans:*` aliases (`plans:parsePlanFolder`, `plans:discoverPlans`, `plans:ensureFrontMatter`, `plans:readBoardConfig`, `plans:writeBoardConfig`).
4. **Premise 4**: In `apps/praxis-desktop/main`, `DEFAULT_MIGRATED_CHANNELS` in `rustHostInstance.ts` only declares `host:*` and `git:*`. Therefore, even if a user sets `PRAXIS_RUST_CHANNELS=all` or `PRAXIS_RUST_CHANNELS=settings:*`, `isChannelMigrated` evaluates to `false` for `settings:*`, `folder:*`, and `plans:*`.
5. **Premise 5**: In `settingsIpc.ts` and `folderIpc.ts`, `ipcMain.handle` is called directly without `RustHostBridge.handleOrFallback`. As seen in commit `4ddca156` (which wired `git:*` channels into `gitIpc.ts`), wiring requires calling `bridge.handleOrFallback(channel, fallback, ipcMain)`.
6. **Premise 6**: When `bridge.handleOrFallback` is used:
   - If the Rust host binary exists and the channel is marked migrated, Electron delegates the call to `praxis-host`.
   - If the Rust host responds with `CHANNEL_NOT_REGISTERED` or if `praxis-host` is disabled/unavailable, it falls back seamlessly to the TypeScript implementation.
   - When `praxis-host` executes `settings:set`, it writes to the shared `settings.json` and emits `settings:changed`, which `RustHostBridge` automatically forwards to all browser windows via `broadcastRustEventToWindows`. Furthermore, `SharedSettingsBackend`'s file watcher detects the disk write and keeps TypeScript state synchronized.
7. **Conclusion**: Wiring `praxis-core` into Electron requires:
   - Adding `folder:discoverPlans` and `plans:*` alias handlers in `crates/praxis-host/src/context.rs`.
   - Adding `folder:*`, `plans:*`, `settings:*`, and `folderService:*` to `DEFAULT_MIGRATED_CHANNELS` in `rustHostInstance.ts`.
   - Updating `settingsIpc.ts` and `folderIpc.ts` (and registering plan channels) using `bridge.handleOrFallback(...)`.
   - Updating unit tests in `rustHostBridge.test.ts` to assert that `folder:*`, `plans:*`, and `settings:*` are routed to Rust and fall back cleanly when unregistered.

---

## 3. Caveats

1. **`connectionId` resolution in Rust vs TypeScript**:
   `folder:discoverPlans` receives a `connectionId` string (e.g., `"conn-1"`). In TypeScript, this looks up the connection in `ConnectionStore` (which reads from `settings.json`). In Rust, `crates/praxis-host` has access to `ctx.settings.read_raw_disk()`. The Rust handler can easily check if `connectionId` matches a connection in `settings.json`'s `"connections"` array to extract its `roots`, or if the argument is a direct folder path on disk, discover plan folders directly. If not found in `settings.json`, falling back to TypeScript guarantees no regression for tests with mocked in-memory connection stores.
2. **`FolderService` in `serviceRegistry.ts`**:
   `serviceRegistry.ts` creates a TypeScript `FolderService` instance for `connection.mode === 'folder'` that tracks disk events and serves `board:list`, `board:get`, and `issue:*` channels. While `crates/praxis-host` provides `folderService:*` RPC channels, Electron main dispatches them via `boardIpc.ts` and `issueIpc.ts` across multiple backends (Jira, GitLab, GitHub, Folder, Demo). Direct IPC routing of `folder:*`, `plans:*`, and `settings:*` via `handleOrFallback` fulfills the acceptance criteria without altering the multi-backend board abstraction in `boardIpc.ts`.
3. **Platform-specific Settings Path in E2E**:
   Playwright e2e sets `PRAXIS_SETTINGS_PATH` to isolate test settings. `StdioRustHostTransport` passes `--settings-path` and `PRAXIS_SETTINGS_PATH` to `praxis-host`, ensuring both TypeScript and Rust read/write the identical isolated file during smoke runs.

---

## 4. Conclusion & Technical Implementation Plan for Worker

### 4.1 Summary of Existing vs Missing

| Component / Channel | Status in `crates/praxis-core` | Status in `crates/praxis-host` | Status in Electron `main` (`apps/praxis-desktop/main`) |
|---|---|---|---|
| `settings:get` | Implemented (`SharedSettingsStore::read`) | Implemented (`context.rs:311`) | Needs `bridge.handleOrFallback` in `settingsIpc.ts` & entry in `DEFAULT_MIGRATED_CHANNELS` |
| `settings:set` | Implemented (`SharedSettingsStore::write`) | Implemented (`context.rs:318`) | Needs `bridge.handleOrFallback` in `settingsIpc.ts` & entry in `DEFAULT_MIGRATED_CHANNELS` |
| `settings:sanitize` | Implemented (`sanitize_app_settings`) | Implemented (`context.rs:334`) | Expose in `DEFAULT_MIGRATED_CHANNELS` |
| `settings:merge` | Implemented (`merge_app_settings`) | Implemented (`context.rs:342`) | Expose in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:discoverPlans` | Implemented (`discover_plan_folders`) | **Missing** (only `discoverPlanFolders` by path exists) | Needs `bridge.handleOrFallback` in `folderIpc.ts` & entry in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:parsePlanFolder` | Implemented (`parse_plan_folder`) | Implemented (`context.rs:540`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:readBoardConfig` | Implemented (`read_board_config_file`) | Implemented (`context.rs:601`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:writeBoardConfig` | Implemented (`write_board_config_file`) | Implemented (`context.rs:617`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:ensureFrontMatter` | Implemented (`ensure_front_matter`) | Implemented (`context.rs:641`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:discoverPlanFolders` | Implemented (`discover_plan_folders`) | Implemented (`context.rs:571`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folder:discoverRepositoryFolders` | Implemented (`discover_repository_folders`) | Implemented (`context.rs:586`) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `plans:*` channels | Implemented in `crates/praxis-core::folder` | **Missing** (need aliases to `folder:*` handlers) | Register via `bridge.handleOrFallback` & in `DEFAULT_MIGRATED_CHANNELS` |
| `folderService:*` channels | Implemented in `crates/praxis-trackers` | Implemented (`context.rs:648-864`) | Expose in `DEFAULT_MIGRATED_CHANNELS` |

### 4.2 Step-by-Step Worker Execution Guide

#### Step 1: Update `crates/praxis-host/src/context.rs`
1. Add `folder:discoverPlans` handler in `register_projects_and_folder_handlers`:
   - Accept string argument `arg` (`connectionId` or path).
   - If `Path::new(arg).exists()`, discover plan folders directly under `arg`.
   - Otherwise, read `ctx.settings.read_raw_disk()`, find connection matching `id == arg`, extract configured `roots` (or `path`), call `discover_plan_folders` for each, deduplicate by lowercase `plans_root_path`, and return `Vec<IdentifiedPlanFolder>`.
   - Return `RustRpcError` with code `"CONNECTION_NOT_FOUND"` if connection not found (allowing graceful TS fallback).
2. Register `plans:*` aliases to provide full parity under the `plans:` prefix:
   - `plans:parsePlanFolder` -> dispatches to `folder:parsePlanFolder` logic
   - `plans:discoverPlanFolders` -> dispatches to `folder:discoverPlanFolders` logic
   - `plans:discoverPlans` -> dispatches to `folder:discoverPlans` logic
   - `plans:readBoardConfig` -> dispatches to `folder:readBoardConfig` logic
   - `plans:writeBoardConfig` -> dispatches to `folder:writeBoardConfig` logic
   - `plans:ensureFrontMatter` -> dispatches to `folder:ensureFrontMatter` logic
3. Verify compilation: `cargo check -p praxis-host`.

#### Step 2: Update `DEFAULT_MIGRATED_CHANNELS` in `apps/praxis-desktop/main/src/main/rustHostInstance.ts`
Add the new channels to `DEFAULT_MIGRATED_CHANNELS`:
```ts
export const DEFAULT_MIGRATED_CHANNELS: readonly string[] = [
  // ... existing host:* and git:* channels ...
  'settings:get',
  'settings:set',
  'settings:sanitize',
  'settings:merge',
  'folder:discoverPlans',
  'folder:discoverPlanFolders',
  'folder:discoverRepositoryFolders',
  'folder:parsePlanFolder',
  'folder:readBoardConfig',
  'folder:writeBoardConfig',
  'folder:ensureFrontMatter',
  'plans:discoverPlans',
  'plans:discoverPlanFolders',
  'plans:parsePlanFolder',
  'plans:readBoardConfig',
  'plans:writeBoardConfig',
  'plans:ensureFrontMatter',
  'folderService:getBoards',
  'folderService:getBoardDetails',
  'folderService:getIssues',
  'folderService:getIssue',
  'folderService:getTransitions',
  'folderService:createIssue',
  'folderService:updateIssue',
  'folderService:transitionIssue',
  'folderService:addComment'
];
```

#### Step 3: Wire `settingsIpc.ts` via `handleOrFallback`
In `apps/praxis-desktop/main/src/main/settingsIpc.ts`:
- Import `getRustHostBridge` from `./rustHostInstance`.
- Wrap `settings:get` and `settings:set` with `bridge.handleOrFallback`:
  ```ts
  const bridge = getRustHostBridge();

  bridge.handleOrFallback(
    'settings:get',
    async () => getSettingsBackend().read(),
    ipcMain
  );

  bridge.handleOrFallback(
    'settings:set',
    async (_event, patch: AppSettingsPatch) => {
      if (patch.mobileAccess?.allowedSubnets?.some(value => normalizeMobileSubnet(value) === undefined)) {
        throw new Error('Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.');
      }
      return getSettingsBackend().write(patch);
    },
    ipcMain
  );
  ```

#### Step 4: Wire `folderIpc.ts` via `handleOrFallback`
In `apps/praxis-desktop/main/src/main/folderIpc.ts`:
- Import `getRustHostBridge` from `./rustHostInstance`.
- Import `parsePlanFolder`, `readBoardConfigFile`, `writeBoardConfigFile`, `ensureFrontMatter`, `discoverRepositoryFolders`, `resolvePlanDependencyKeys` from `@praxis/core`.
- Wrap `folder:discoverPlans` with `bridge.handleOrFallback`.
- Register `folder:*` and `plans:*` channels with their TypeScript `@praxis/core` fallbacks via `bridge.handleOrFallback`.

#### Step 5: Add Unit & Parity Tests in `rustHostBridge.test.ts`
- Add tests to assert:
  1. `DEFAULT_MIGRATED_CHANNELS` contains `settings:get`, `settings:set`, `folder:discoverPlans`, `folder:parsePlanFolder`, and `plans:*`.
  2. `bridge.handleOrFallback` routes `settings:get` and `settings:set` through Rust when migrated, falling back when unmigrated.
  3. `bridge.handleOrFallback` routes `folder:discoverPlans`, `folder:parsePlanFolder`, and `plans:*` through Rust when migrated.

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Rust workspace check and test**:
   ```bash
   node scripts/cargo-workspace.mjs check
   node scripts/cargo-workspace.mjs test
   ```
2. **TypeScript typechecking**:
   ```bash
   npm --prefix apps/praxis-desktop/main run check-types
   ```
3. **Main & Git unit test suite**:
   ```bash
   npm --prefix apps/praxis-desktop/main run test:git
   ```
   *Expected outcome*: 181+ tests pass, including all `rustHostBridge.test.ts` tests.
4. **Smoke test suite** (requires pre-built renderer and compiled desktop):
   ```bash
   npm run build:rust
   npm run build:core
   npm run build:renderer
   npm run desktop:copy-renderer
   npm run build:desktop
   npm run test:desktop:smoke
   ```
   *Expected outcome*: Smoke specs pass (`folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, `newIssue.spec.ts`, `settingsReset.spec.ts`, `app.spec.ts`, etc.) with `PRAXIS_RUST_CHANNELS` active.

### 5.2 Invalidation Conditions
- If `settings:set` fails to emit `settings:changed` or leaves `settings.json` in an unparseable state.
- If `folder:discoverPlans` throws uncaught errors when connection ID is not yet in `settings.json` instead of falling back to TypeScript.
- If `npm run check-ipc-senders` flags privileged IPC imports (must use `trustedIpcMain`).
- If any smoke test in `folder.spec.ts`, `editIssue.spec.ts`, or `settingsReset.spec.ts` times out or fails.
