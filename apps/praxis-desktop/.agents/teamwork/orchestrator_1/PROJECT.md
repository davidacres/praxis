# Project: Praxis Rust Migration (Production Phase)

## Architecture
The migration of Praxis desktop services from TypeScript to Rust spans three independent core domains:
1. **Workflows Runtime (`crates/praxis-workflows`)**:
   - Manages service lifecycles, readiness probes (HTTP, TCP, LogLine, Settle), command exits, and process trees via `run_service_manager.rs`.
   - Manages scheduled run execution, durable lease recovery on launch via `recover()` and `settle_interrupted_launch()`, and recurring cron expressions with timezone awareness via `cron_scheduler.rs`.
2. **Host Bridge & Electron Core Wiring (`crates/praxis-host` & `apps/praxis-desktop/main`)**:
   - `praxis-host` exposes NDJSON RPC over stdio for `settings:*`, `folder:*`, `plans:*`, and `folderService:*`.
   - `RustHostBridge.handleOrFallback` wraps IPC handlers in Electron main, delegating to Rust when enabled in `DEFAULT_MIGRATED_CHANNELS` and falling back cleanly to `@praxis/core` when unmigrated or unsupported.
3. **AI MCP / ACP Runtime (`crates/praxis-ai`)**:
   - Model Context Protocol (`mcp`): JSON-RPC 2.0 tool server registry, Stdio/Http tool transports, client pool with 64-char namespacing, output truncation, and built-in servers (`read_only_files`, `tracker`, `coordination`).
   - Agent Client Protocol (`acp`): CLI agent process supervisor, tool permission gating (`ReadOnly`, `ProjectOnly`, `Full`), and sandboxed file access.
   - Virtual Team Chat (`team_chat`): multi-persona turn orchestration, canonical SHA-256 payload idempotency, epoch crash fencing, and atomic `.tmp` + `fsync` + `rename` durability.
   - Interactive Chat Gadgets (`gadgets`): 12 gadget kinds, 128KB envelope limit, secret regex redaction (`[redacted]`), lenient JSON string quote repair, block parser, and array truncation.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Service Manager Readiness Probes | HTTP, TCP, LogLine, Settle probes in `run_service_manager.rs` | M1 | TASK-522 / ORIGINAL_REQUEST §R1 |
| 2 | Service Manager Command Exits | Exit-before-ready and unexpected-exit handling, process tree termination | M1 | TASK-522 / ORIGINAL_REQUEST §R1 |
| 3 | Overdue Run Detection | Reconcile overdue scheduled runs on launch to Missed status | M1 | TASK-523 / ORIGINAL_REQUEST §R1 |
| 4 | Durable Lease Recovery | Settle interrupted launches on restart with launch tokens & exclusive locks | M1 | TASK-523 / ORIGINAL_REQUEST §R1 |
| 5 | Cron Scheduler | Timezone-aware cron parsing, next occurrence calculation, and overdue run detection | M1 | TASK-523 / ORIGINAL_REQUEST §R1 |
| 6 | Settings RPC & Store Integration | Wire `settings:get`, `settings:set`, `settings:sanitize`, `settings:merge` via `handleOrFallback` | M2 | ORIGINAL_REQUEST §R2 |
| 7 | Plans Front-Matter & Discovery RPC | Wire `folder:discoverPlans`, `folder:parsePlanFolder`, `plans:*` via `handleOrFallback` | M2 | ORIGINAL_REQUEST §R2 |
| 8 | Board Synthesizer & FolderService RPC | Expose `folderService:*` and `folder:readBoardConfig`/`writeBoardConfig` in host bridge | M2 | ORIGINAL_REQUEST §R2 |
| 9 | Default Migrated Channels Registration | Add `settings:*`, `folder:*`, `plans:*`, `folderService:*` to `DEFAULT_MIGRATED_CHANNELS` | M2 | ORIGINAL_REQUEST §R2 |
| 10 | MCP Server Registry & Transports | JSON-RPC 2.0 Stdio/Http transports, client pooling, tool namespacing, built-in servers | M3 | TASK-525 / ORIGINAL_REQUEST §R3 |
| 11 | ACP Stdio Bridge & Supervisor | Agent CLI supervisor, `session/request_permission` gating by tool mode, sandboxed FS | M3 | TASK-525 / ORIGINAL_REQUEST §R3 |
| 12 | Durable Team Chat Persistence | Multi-persona conversation state machine, SHA-256 digest idempotency, atomic temp-rename storage | M3 | TASK-526 / ORIGINAL_REQUEST §R3 |
| 13 | Interactive Gadget Validation & Repair | 12 gadget kinds, 128KB limit, secret redaction, lenient JSON repair, table trimming | M3 | TASK-526 / ORIGINAL_REQUEST §R3 |
| 14 | Cross-Workstream Verification | Run all unit tests, git tests, and desktop Playwright smoke tests | M4 | ORIGINAL_REQUEST §Verification |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Workstream A: Workflows | `crates/praxis-workflows`: add `cron_scheduler.rs`, verify readiness probes, command exits, and lease recovery | None | PLANNED |
| M2 | Workstream B: Electron Core Wiring | `crates/praxis-host` & `apps/praxis-desktop/main`: wire `folder:*`, `plans:*`, `settings:*` via `handleOrFallback` | None | PLANNED |
| M3 | Workstream C: AI MCP / ACP Runtime | `crates/praxis-ai`: implement `mcp`, `acp`, `team_chat`, `gadgets` modules | None | PLANNED |
| M4 | Final Integration & Verification | Full verification: `cargo test -p praxis-workflows`, `cargo test -p praxis-ai`, `npm run test:git`, and `npm run test:desktop:smoke` | M1, M2, M3 | PLANNED |

## Interface Contracts
### `crates/praxis-workflows::cron_scheduler`
- `CronSchedule::new(expression: &str, timezone_str: &str) -> Result<Self, CronScheduleError>`
- `CronSchedule::next_after(&self, after_utc: DateTime<Utc>) -> Option<DateTime<Utc>>`
- `CronSchedule::find_overdue_runs(&self, last_run_utc: DateTime<Utc>, now_utc: DateTime<Utc>) -> Vec<DateTime<Utc>>`

### `crates/praxis-host` ↔ Electron Main (`RustHostBridge`)
- Request: `RustRpcRequest { id: String, channel: String, payload: serde_json::Value }`
- Response: `RustRpcResponse { id: String, result: Option<Value>, error: Option<RustRpcError> }`
- Error codes: `"CHANNEL_NOT_REGISTERED"`, `"CONNECTION_NOT_FOUND"`, `"VALIDATION_ERROR"`
- Electron delegation: `bridge.handleOrFallback(channel, fallback, ipcMain)`
- Event emission: `HostWireFrame::Event { channel, payload }` broadcast to windows

### `crates/praxis-ai` Core Modules
- `mcp`: `McpClientPool`, `McpServerRegistry`, `StdioTransport`, `HttpTransport`, `mcp_tool_name`
- `acp`: `AcpClient`, `AcpAgentHost`, `AgentToolMode` (`ReadOnly`, `ProjectOnly`, `Full`)
- `team_chat`: `DurableConversation`, `submit_conversation_turn`, `begin_conversation_epoch`, `FileTeamChatRepository`
- `gadgets`: `validate_gadget_envelope`, `repair_json_strings`, `parse_chat_blocks`, `redact_secrets`

## Code Layout
- `crates/praxis-workflows/src/cron_scheduler.rs`
- `crates/praxis-workflows/src/lib.rs`
- `crates/praxis-host/src/context.rs`
- `apps/praxis-desktop/main/src/main/rustHostInstance.ts`
- `apps/praxis-desktop/main/src/main/settingsIpc.ts`
- `apps/praxis-desktop/main/src/main/folderIpc.ts`
- `apps/praxis-desktop/main/src/main/rustHostBridge.test.ts`
- `crates/praxis-ai/Cargo.toml`
- `crates/praxis-ai/src/lib.rs`
- `crates/praxis-ai/src/mcp/`
- `crates/praxis-ai/src/acp/`
- `crates/praxis-ai/src/team_chat/`
- `crates/praxis-ai/src/gadgets/`
