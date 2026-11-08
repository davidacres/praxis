---
**Created:** 2026-11-07T21:20:27.517Z
id: TASK-513
type: Task
status: Done
---

# Build praxis-host Rust service container and RPC dispatcher

**Status:** Done
**Type:** Task
**Priority:** Critical

## Description

Create `crates/praxis-host` to hold the shell-agnostic Rust service container (`HostContext`), typed channel dispatcher (`dispatch_rpc(channel, payload)`), broadcast event bus (`HostEventBus`), and isolated `--user-data-dir` / `safeStorage`-unlocked secret store integration. Expose both an N-API binding (`napi-rs`) for in-process Electron calls and a standalone test harness so Rust integration tests and Playwright E2E workers run with complete per-worker directory isolation. Can be developed in parallel with `TASK-512` once `TASK-511` lands.

## Acceptance Criteria

- `crates/praxis-host` initializes cleanly with an isolated `user_data_dir`, settings path, and demo flag (`PRAXIS_E2E=1`).
- Electron main process and Rust integration tests can invoke typed RPC methods on `praxis-host` and subscribe to emitted domain events.

## Dependencies

- `TASK-511`

## Comments


