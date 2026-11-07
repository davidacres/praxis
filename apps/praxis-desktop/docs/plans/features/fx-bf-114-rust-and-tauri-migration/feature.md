---
**Created:** 2026-11-07T21:20:22.380Z
id: FX-BF-114
type: Feature
status: In Progress
---

# Rust Backend Migration behind Thin Electron Shell (with Optional Tauri v2 Follow-Up)

**Status:** In Progress
**Type:** Feature
**Priority:** Critical

## Description

Migrate Praxis's runtime backend (`@praxis/core`, `@praxis/mobile-protocol`, `@praxis/mobile-relay`, and the service layer of `@praxis/desktop-main`) to a modular Rust workspace (`crates/praxis-*`) running behind the existing **thin Electron shell**, while keeping the React/Vite renderer (`@praxis/desktop-renderer`), Chromium `WebContentsView` browsers (`previewBrowser` and `aiBrowser`), `safeStorage` keychain integration, and the Playwright `_electron.launch()` E2E verification suite 100% intact. A full Tauri v2 shell replacement (`FX-BE-199`) is retained as an optional, low-priority Wave 4 follow-up once Waves 1–3 are proven in production.

### Architectural Goals

1. **Zero-Drift Renderer & Electron IPC Contract**: Generate `packages/core/src/host/ipcContracts.ts` directly from `crates/praxis-contracts` Rust types via `specta` and bridge Electron's `ipcMain` (`trustedIpcMain`) to `crates/praxis-host` via N-API (`napi-rs`) or local loopback RPC so `window.praxis` and `@praxis/desktop-renderer` require zero UI changes.
2. **100% Playwright E2E, Chromium & Keychain Preservation**: Keep Electron as the thin window shell for Waves 1–3 so `_electron.launch()`, `@theme` pixel snapshots, `WebContentsView` (`previewBrowser` / `aiBrowser` with `ses.webRequest` sandboxing), and OS `safeStorage` tokens continue to work without re-authentication or WebKit CSS differences.
3. **File Format & Safety Invariants**: Preserve byte-for-byte behavior of `.workspace.praxis.json` (secret key stripping, relative path resolution, `folderInspection` omission), `board.praxis.json` (loaded before markdown parsing), `project.praxis.md` (`praxis:begin`/`praxis:end` marker-only rewrites), and `resolveStatus` (4-tier status mapping with `DEFAULT_WORKFLOW`).
4. **Decoupled Host Crate for Optional Tauri v2 Follow-Up**: Keep `crates/praxis-host` independent of Electron APIs so Wave 4 (`FX-BE-199`, `Low` priority) can optionally wrap the exact same Rust backend in Tauri v2 later if installer size reduction is desired.

### Priority Tiers, Execution Waves & Parallelism

Work is organized into **3 Primary Waves (Electron + Rust Backend)** plus **1 Optional Wave 4 (Tauri v2 Shell)** across **4 Priority Tiers (`Critical` $\rightarrow$ `High` $\rightarrow$ `Medium` $\rightarrow$ `Low`)**, structured so independent Rust crates can be built in parallel worktrees without merge conflicts:

| Wave | Priority Tier | Sequential Gate (Must Finish First) | Parallel Workstreams (Can Run Simultaneously) |
| --- | --- | --- | --- |
| **Wave 1** (`FX-BE-194`) | **P0 — `Critical`** | `TASK-510` (Cargo workspace) $\rightarrow$ `TASK-511` (`specta` contract codegen) | `TASK-512` (Electron-to-Rust `praxis-host` IPC bridge) **$\parallel$** `TASK-513` (Rust `praxis-host` service container & test harness) |
| **Wave 2** (`FX-BE-195`) | **P0 — `Critical`** | `TASK-514` (`AppSettings` & `.workspace.praxis.json` in `praxis-core`) | **3-way parallel fan-out**:<br>• `TASK-515` (`Critical`: `resolveStatus` & `FolderService`)<br>• `TASK-516` (`High`: `git` CLI, graph & worktrees)<br>• `TASK-517` (`Medium`: `pathSandbox`, `unifiedDiff` & `marketplace`) |
| **Wave 3** (`FX-BE-196`, `FX-BE-197`, `FX-BE-198`) | **P1 — `High` & P2 — `Medium`** | Starts immediately after Wave 2 (`FX-BE-195`); internal story roots (`TASK-518`, `TASK-521`, `TASK-524`) run in parallel | **Up to 5 concurrent crate tracks**:<br>• **Track A (`praxis-trackers`)**: `TASK-518` (`High`: Jira/GitHub/GitLab/CI)<br>• **Track B (`portable-pty`)**: `TASK-519` (`Medium`: terminal manager)<br>• **Track C (`praxis-mobile`)**: `TASK-520` (`Medium`: mobile LAN WS & relay)<br>• **Track D (`praxis-workflows`)**: `TASK-521` (`High`: state machine/gates) $\rightarrow$ (`TASK-522` `High` **$\parallel$** `TASK-523` `Medium`)<br>• **Track E (`praxis-ai`)**: `TASK-524` (`High`: LLM wire adapters) $\rightarrow$ (`TASK-525` `High` **$\parallel$** `TASK-526` `High`) |
| **Wave 4 (Optional Phase 2)** (`FX-BE-199`) | **P3 — `Low`** | Optional follow-up after Waves 1–3 ship the complete Rust backend in Electron | `TASK-527` (`Low`: Optional Tauri v2 shell, `wry` child webviews + loopback SSRF proxy, and Tauri installers) |

## Stories

- `FX-BE-194` (`Critical`, Wave 1) — Cargo Workspace, IPC Contract Codegen, and Electron-to-Rust Host Bridge
- `FX-BE-195` (`Critical`, Wave 2) — Port Core Settings, Workspaces, Folder Backend, and Git to Rust
- `FX-BE-196` (`Medium`, Wave 3 Parallel Track A/B/C) — Port External Trackers, Portable PTY Terminal, and Mobile Host
- `FX-BE-197` (`High`, Wave 3 Parallel Track D) — Port Workflow Engine, Managed Run Services, and Scheduled Runs
- `FX-BE-198` (`High`, Wave 3 Parallel Track E) — Port AI Wire Providers, MCP Servers, ACP Host, and Team Chat
- `FX-BE-199` (`Low`, Wave 4 Optional Follow-Up) — Optional Phase 2: Tauri v2 Shell and Multi-Webview Proxy Cutover

## Dependencies

None

## Comments


