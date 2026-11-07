---
**Created:** 2026-11-07T21:20:26.707Z
id: TASK-512
type: Task
status: To Do
---

# Implement Tauri and WebSocket window.praxis renderer adapter

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Create `apps/praxis-desktop/renderer/src/host/installPraxisBridge.ts` to populate `window.praxis` (`PraxisIpc`) when not already injected by Electron preload. Support two runtime transports behind a unified `RpcTransport` interface:
1. Tauri v2 runtime (`window.__TAURI_INTERNALS__`) using `@tauri-apps/api/core` `invoke('praxis_rpc', ...)` and a synchronous-unsubscribe event multiplexer over `@tauri-apps/api/event`.
2. Playwright E2E WebSocket mode (`window.__PRAXIS_E2E_WS_URL__`) for `praxis-test-host`.

## Acceptance Criteria

- All `window.praxis.*` methods and `on*` event subscriptions in `PraxisIpc` work identically across Electron preload, Tauri v2 IPC, and the E2E WebSocket bridge.
- Synchronous `() => void` unsubscribe callbacks returned by `on*` methods cleanly detach listeners without race conditions in React `useEffect` cleanup hooks.

## Dependencies

- `TASK-511`

## Comments


