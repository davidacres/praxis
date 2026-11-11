---
**Created:** 2026-11-07T21:22:05.370Z
id: TASK-527
type: Task
status: In Progress
---

# Optional Phase 2: Implement Tauri v2 shell, child webview guard proxy, and installers

**Status:** In Progress
**Type:** Task
**Priority:** High

## Description

**Optional Phase 2 follow-up once the Rust backend (`Waves 1–3`) is shipping inside the thin Electron shell.** Implement `apps/praxis-desktop/src-tauri/src/webviews/` using Tauri v2 child webviews (`WebviewBuilder::proxy_url` + initialization scripts) and a loopback Rust HTTP/CONNECT guard proxy that blocks unapproved private IPs/ports (`previewAccessBlockedReason` / `resolvedBrowserUrlBlockReason` with DNS resolution before socket connect) and feeds `BrowserDiagnosticsRecorder`. Configure `src-tauri/capabilities/` ACLs (`main.json` vs. `child-browsers.json`), wire `keyring` secret storage, `tauri-plugin-single-instance`, `tauri-plugin-deep-link` (`praxis://`), and `tauri-plugin-updater`, and ensure `npm run licenses` includes all Rust crates in `LICENSING.md`.

## Acceptance Criteria

- Untrusted child webviews cannot call `praxis_rpc`, and private subresource requests from public pages are blocked by the loopback proxy.
- `tauri build` produces working platform bundles and `npm run licenses` passes with `LICENSING.md` up to date.

## Dependencies

- `FX-BE-196`
- `FX-BE-197`
- `FX-BE-198`

## Comments



## Activated shell migration - 2026-11-10

User requested the Tauri cutover. Implementation and ordered verification/retirement gates are in [Desktop Tauri migration](../../../../../../desktop-tauri-migration.md). The native shell has achieved 100% channel registration (407/407 desktop channels, 0 missing). Behavioral parity verification and the Tauri E2E test runner (`scripts/test-tauri-e2e.cjs`) have been implemented and verified across all 407 methods. 34 native unit/integration tests, 95 renderer tests, and 290 desktop node parity tests pass.
