---
**Created:** 2026-11-07T21:22:03.920Z
id: FX-BE-199
type: Story
status: In Progress
---

# Optional Phase 2: Tauri v2 Shell and Multi-Webview Proxy Cutover

**Status:** In Progress
**Type:** Story
**Priority:** High

## Description

**Optional Phase 2 follow-up after Waves 1–3 complete the Rust backend inside the thin Electron shell.** If replacing the ~90 MB Chromium/Electron wrapper with an OS-native webview shell is desired later, create `apps/praxis-desktop/src-tauri` wrapping `crates/praxis-host`, implement Tauri v2 multi-webview management for `previewBrowser` and `aiBrowser` (backed by a loopback SSRF/subresource guard proxy and capability ACLs), native OS keychain integration (`keyring`), single-instance and `praxis://` deep-link handling, and Tauri installer packaging.

### Execution Order & Parallelism (Wave 4 — Optional Phase 2 Follow-Up)

- **Decoupled from Primary Delivery**: Waves 1–3 (`FX-BE-194` through `FX-BE-198`) deliver the complete Rust backend inside the existing thin Electron shell with 100% Playwright `_electron.launch()` and `WebContentsView` compatibility.
- **Optional Cutover Gate**: `FX-BE-199` is `Low` priority and only starts if/when the team decides to trade Electron's bundled Chromium for Tauri v2's smaller OS-webview footprint.

## Tasks

- `TASK-527` (`Low`, Wave 4 Optional Follow-Up) — Optional Phase 2: Implement Tauri v2 shell, child webview guard proxy, and installers

## Acceptance Criteria

- Child webviews (`preview-browser` and `ai-browser`) enforce private-network/SSRF subresource blocking via the loopback Rust proxy, capture HTTP/console/error diagnostics, detect trusted user input (`personUsedBrowser`), and cannot invoke privileged `praxis_rpc` commands.
- `npm run test:full` and `cargo test --workspace` pass.
- `npm run licenses` updates `LICENSING.md` with both npm and Cargo third-party dependencies and zero unresolved review items.

## Dependencies

- `FX-BE-196`
- `FX-BE-197`
- `FX-BE-198`

## Comments



## Activated shell migration - 2026-11-10

User requested the Tauri cutover. Implementation and ordered verification/retirement gates are in [Desktop Tauri migration](../../../../../desktop-tauri-migration.md). The new shell is a preview; this item remains In Progress until application contracts, child webview isolation and packaged release gates pass.

Issue mirror: [FX-BE-199](../../../../../issues/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-199-tauri-v2-shell-webviews-and-cutover/issue.md).

## Status - 2026-11-13

The Tauri shell is the live desktop host, and the functional e2e suite passes against it for the areas listed in `apps/praxis-desktop/docs/desktop-feature-parity.md`. Still open: the child-webview browser is compiled but has not been exercised in a native window; the packaged `tauri build` bundles and the zero-TypeScript UI are not verified; Windows and Linux are not verified. Stays In Progress.
