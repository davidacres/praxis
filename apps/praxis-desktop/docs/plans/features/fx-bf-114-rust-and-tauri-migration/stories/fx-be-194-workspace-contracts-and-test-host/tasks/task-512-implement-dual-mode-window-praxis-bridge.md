---
**Created:** 2026-11-07T21:20:26.707Z
id: TASK-512
type: Task
status: To Do
---

# Bridge Electron trustedIpcMain and window.praxis events to Rust host

**Status:** To Do
**Type:** Task
**Priority:** Critical

## Description

Implement the Electron-to-Rust host adapter in `apps/praxis-desktop/main/src/main/rustHostBridge.ts` so `trustedIpcMain.handle(channel, ...)` delegates migrated channels directly to `crates/praxis-host` (via `napi-rs` in-process binding or loopback RPC) and forwards Rust-emitted domain events (`settings:changed`, `workflow:*`, `ai:*`, `terminal:*`) to `mainWindow.webContents.send(...)` and detached chat windows. Keep `preload/index.ts`, `window.praxis`, and `checkTrustedIpc.cjs` sender verification 100% intact.

## Acceptance Criteria

- Migrated IPC channels can be switched from TypeScript handlers to `rustHostBridge` one domain at a time without touching `preload/index.ts` or `@praxis/desktop-renderer`.
- `npm run check-trusted-ipc` and `_electron.launch()` Playwright E2E tests pass with full sender isolation against untrusted child `WebContentsView` instances.

## Dependencies

- `TASK-511`

## Comments


