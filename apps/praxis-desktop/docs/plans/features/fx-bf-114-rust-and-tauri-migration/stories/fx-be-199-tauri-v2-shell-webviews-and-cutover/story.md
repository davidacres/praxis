---
**Created:** 2026-11-07T21:22:03.920Z
id: FX-BE-199
type: Story
status: To Do
---

# Build Tauri v2 Shell, Multi-Webview Proxy, and Packaging Cutover

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Complete `apps/praxis-desktop/src-tauri` with Tauri v2 multi-webview management for `previewBrowser` and `aiBrowser` (backed by the loopback SSRF/subresource guard proxy and capability ACLs), native OS keychain integration (`keyring`), single-instance and `praxis://` deep-link handling, detached chat windows, OS installer packaging (`.dmg`, NSIS `.exe`, `.deb`/`.AppImage`), and `LICENSING.md` generation for Cargo dependencies.

### Execution Order & Parallelism (Wave 4 — Final Shell Cutover, with Early Prototyping in Wave 3)

- **Early Parallel Prototyping**: The `src-tauri/src/webviews/` child-webview positioning, loopback SSRF guard proxy, and `capabilities/` ACLs depend only on `FX-BE-194` and `TASK-517` (`networkAddress`), so they can be developed in parallel during Wave 3.
- **Final Cutover Gate**: Removing Electron and switching packaging/CI over to `tauri build` is gated on `FX-BE-196`, `FX-BE-197`, and `FX-BE-198` completing all backend IPC channels.

## Tasks

- `TASK-527` (`High`, Wave 4 Cutover) — Implement Tauri v2 child webviews, capabilities ACL, and installers

## Acceptance Criteria

- Child webviews (`preview-browser` and `ai-browser`) enforce private-network/SSRF subresource blocking via the loopback Rust proxy, capture HTTP/console/error diagnostics, detect trusted user input (`personUsedBrowser`), and cannot invoke privileged `praxis_rpc` commands.
- `npm run test:full` and `cargo test --workspace` pass.
- `npm run licenses` updates `LICENSING.md` with both npm and Cargo third-party dependencies and zero unresolved review items.

## Dependencies

- `FX-BE-196`
- `FX-BE-197`
- `FX-BE-198`

## Comments


