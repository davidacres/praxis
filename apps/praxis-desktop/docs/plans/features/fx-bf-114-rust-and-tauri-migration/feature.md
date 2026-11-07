---
**Created:** 2026-11-07T21:20:22.380Z
id: FX-BF-114
type: Feature
status: To Do
---

# Rust Host and Tauri v2 Desktop Migration

**Status:** To Do
**Type:** Feature
**Priority:** Critical

## Description

Migrate Praxis's runtime backend (`@praxis/core`, `@praxis/mobile-protocol`, `@praxis/mobile-relay`, and `@praxis/desktop-main`) to a modular Rust workspace (`crates/praxis-*`) and replace the Electron shell with a Tauri v2 desktop host (`apps/praxis-desktop/src-tauri`) while keeping the React/Vite renderer (`@praxis/desktop-renderer`) and Playwright E2E verification suite intact.

### Architectural Goals

1. **Zero-Drift Renderer Contract**: Generate `packages/core/src/host/ipcContracts.ts` directly from `crates/praxis-contracts` Rust types via `specta` and expose a dual-transport `window.praxis` adapter supporting both Tauri v2 IPC (`window.__TAURI_INTERNALS__`) and a loopback WebSocket test server (`praxis-test-host`).
2. **Playwright E2E & Visual Snapshot Preservation**: Run the full Playwright functional and `@theme` visual regression suite against Chromium backed by `praxis-test-host`, paired with a native Tauri v2 window and child-webview smoke suite.
3. **File Format & Safety Invariants**: Preserve byte-for-byte behavior of `.workspace.praxis.json` (secret key stripping, relative path resolution, `folderInspection` omission), `board.praxis.json` (loaded before markdown parsing), `project.praxis.md` (`praxis:begin`/`praxis:end` marker-only rewrites), and `resolveStatus` (4-tier status mapping with `DEFAULT_WORKFLOW`).
4. **Secure Multi-Webview Isolation**: Replace Electron `WebContentsView` and `ses.webRequest` in `previewBrowser` and `aiBrowser` with Tauri v2 child webviews routed through a loopback Rust guard proxy that enforces DNS-resolved private-network/SSRF blocking, HTTP status diagnostics, console/error capture, and capability-based IPC isolation.

### Priority Tiers, Execution Waves & Parallelism

Work is organized into **4 Execution Waves** across **3 Priority Tiers (`Critical` $\rightarrow$ `High` $\rightarrow$ `Medium`)**, structured so independent Rust crates can be built in parallel worktrees without merge conflicts:

| Wave | Priority Tier | Sequential Gate (Must Finish First) | Parallel Workstreams (Can Run Simultaneously) |
| --- | --- | --- | --- |
| **Wave 1** (`FX-BE-194`) | **P0 — `Critical`** | `TASK-510` (Cargo workspace) $\rightarrow$ `TASK-511` (`specta` contract codegen) | `TASK-512` (TS `window.praxis` adapter in `renderer/`) **$\parallel$** `TASK-513` (Rust `praxis-test-host` server in `crates/praxis-host`) |
| **Wave 2** (`FX-BE-195`) | **P0 — `Critical`** | `TASK-514` (`AppSettings` & `.workspace.praxis.json` in `praxis-core`) | **3-way parallel fan-out**:<br>• `TASK-515` (`Critical`: `resolveStatus` & `FolderService`)<br>• `TASK-516` (`High`: `git` CLI, graph & worktrees)<br>• `TASK-517` (`Medium`: `pathSandbox`, `unifiedDiff` & `marketplace`) |
| **Wave 3** (`FX-BE-196`, `FX-BE-197`, `FX-BE-198`) | **P1 — `High` & P2 — `Medium`** | Starts immediately after Wave 2 (`FX-BE-195`); internal story roots (`TASK-518`, `TASK-521`, `TASK-524`) run in parallel | **Up to 5 concurrent crate tracks**:<br>• **Track A (`praxis-trackers`)**: `TASK-518` (`High`: Jira/GitHub/GitLab/CI)<br>• **Track B (`portable-pty`)**: `TASK-519` (`Medium`: terminal manager)<br>• **Track C (`praxis-mobile`)**: `TASK-520` (`Medium`: mobile LAN WS & relay)<br>• **Track D (`praxis-workflows`)**: `TASK-521` (`High`: state machine/gates) $\rightarrow$ (`TASK-522` `High` **$\parallel$** `TASK-523` `Medium`)<br>• **Track E (`praxis-ai`)**: `TASK-524` (`High`: LLM wire adapters) $\rightarrow$ (`TASK-525` `High` **$\parallel$** `TASK-526` `High`) |
| **Wave 4** (`FX-BE-199`) | **P1 — `High`** | Final cutover waits for Wave 3 (`FX-BE-196`, `FX-BE-197`, `FX-BE-198`); webview proxy can be prototyped after `TASK-517` | `TASK-527` (`High`: `src-tauri` child webviews, loopback SSRF proxy, capability ACLs, installers, `LICENSING.md`) |

## Stories

- `FX-BE-194` (`Critical`, Wave 1) — Cargo Workspace, IPC Contract Codegen, and Playwright Test Host
- `FX-BE-195` (`Critical`, Wave 2) — Port Core Settings, Workspaces, Folder Backend, and Git to Rust
- `FX-BE-196` (`Medium`, Wave 3 Parallel Track A/B/C) — Port External Trackers, Portable PTY Terminal, and Mobile Host
- `FX-BE-197` (`High`, Wave 3 Parallel Track D) — Port Workflow Engine, Managed Run Services, and Scheduled Runs
- `FX-BE-198` (`High`, Wave 3 Parallel Track E) — Port AI Wire Providers, MCP Servers, ACP Host, and Team Chat
- `FX-BE-199` (`High`, Wave 4 Cutover) — Build Tauri v2 Shell, Multi-Webview Proxy, and Packaging Cutover

## Dependencies

None

## Comments


