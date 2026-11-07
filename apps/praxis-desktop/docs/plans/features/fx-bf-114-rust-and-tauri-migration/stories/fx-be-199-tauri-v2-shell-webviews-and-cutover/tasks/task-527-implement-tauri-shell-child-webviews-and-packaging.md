---
**Created:** 2026-11-07T21:22:05.370Z
id: TASK-527
type: Task
status: To Do
---

# Implement Tauri v2 child webviews, capabilities ACL, and installers

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Implement `apps/praxis-desktop/src-tauri/src/webviews/` using Tauri v2 child webviews (`WebviewBuilder::proxy_url` + initialization scripts) and a loopback Rust HTTP/CONNECT guard proxy that blocks unapproved private IPs/ports (`previewAccessBlockedReason` / `resolvedBrowserUrlBlockReason` with DNS resolution before socket connect) and feeds `BrowserDiagnosticsRecorder`. Configure `src-tauri/capabilities/` ACLs (`main.json` vs. `child-browsers.json`), wire `keyring` secret storage, `tauri-plugin-single-instance`, `tauri-plugin-deep-link` (`praxis://`), and `tauri-plugin-updater`, and update `npm run licenses` to include Rust crates in `LICENSING.md`.

## Acceptance Criteria

- Untrusted child webviews cannot call `praxis_rpc`, and private subresource requests from public pages are blocked by the loopback proxy.
- `tauri build` produces working platform bundles and `npm run licenses` passes with `LICENSING.md` up to date.

## Dependencies

- `FX-BE-196`
- `FX-BE-197`
- `FX-BE-198`

## Comments


