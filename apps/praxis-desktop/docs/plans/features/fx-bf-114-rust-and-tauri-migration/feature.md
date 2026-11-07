---
**Created:** 2026-11-07T21:20:22.380Z
id: FX-BF-114
type: Feature
status: To Do
---

# Rust Host and Tauri v2 Desktop Migration

**Status:** To Do
**Type:** Feature
**Priority:** High

## Description

Migrate Praxis's runtime backend (`@praxis/core`, `@praxis/mobile-protocol`, `@praxis/mobile-relay`, and `@praxis/desktop-main`) to a modular Rust workspace (`crates/praxis-*`) and replace the Electron shell with a Tauri v2 desktop host (`apps/praxis-desktop/src-tauri`) while keeping the React/Vite renderer (`@praxis/desktop-renderer`) and Playwright E2E verification suite intact.

### Architectural Goals

1. **Zero-Drift Renderer Contract**: Generate `packages/core/src/host/ipcContracts.ts` directly from `crates/praxis-contracts` Rust types via `specta` and expose a dual-transport `window.praxis` adapter supporting both Tauri v2 IPC (`window.__TAURI_INTERNALS__`) and a loopback WebSocket test server (`praxis-test-host`).
2. **Playwright E2E & Visual Snapshot Preservation**: Run the full Playwright functional and `@theme` visual regression suite against Chromium backed by `praxis-test-host`, paired with a native Tauri v2 window and child-webview smoke suite.
3. **File Format & Safety Invariants**: Preserve byte-for-byte behavior of `.workspace.praxis.json` (secret key stripping, relative path resolution, `folderInspection` omission), `board.praxis.json` (loaded before markdown parsing), `project.praxis.md` (`praxis:begin`/`praxis:end` marker-only rewrites), and `resolveStatus` (4-tier status mapping with `DEFAULT_WORKFLOW`).
4. **Secure Multi-Webview Isolation**: Replace Electron `WebContentsView` and `ses.webRequest` in `previewBrowser` and `aiBrowser` with Tauri v2 child webviews routed through a loopback Rust guard proxy that enforces DNS-resolved private-network/SSRF blocking, HTTP status diagnostics, console/error capture, and capability-based IPC isolation.

## Stories

- `FX-BE-194` — Cargo Workspace, IPC Contract Codegen, and Playwright Test Host
- `FX-BE-195` — Port Core Settings, Workspaces, Folder Backend, and Git to Rust
- `FX-BE-196` — Port External Trackers, Portable PTY Terminal, and Mobile Host
- `FX-BE-197` — Port Workflow Engine, Managed Run Services, and Scheduled Runs
- `FX-BE-198` — Port AI Wire Providers, MCP Servers, ACP Host, and Team Chat
- `FX-BE-199` — Build Tauri v2 Shell, Multi-Webview Proxy, and Packaging Cutover

## Dependencies

None

## Comments


