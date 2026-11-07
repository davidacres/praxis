---
**Created:** 2026-11-07T21:20:24.318Z
id: FX-BE-194
type: Story
status: In Progress
---

# Cargo Workspace, IPC Contract Codegen, and Electron-to-Rust Host Bridge

**Status:** In Progress
**Type:** Story
**Priority:** Critical

## Description

Establish the root Cargo workspace (`crates/praxis-*`), generate TypeScript IPC contracts from Rust definitions so `@praxis/desktop-renderer` stays strictly type-checked via `npm run check-core-imports`, bridge Electron's `ipcMain` (`trustedIpcMain`) to the Rust `praxis-host` service container (via `napi-rs` or local loopback RPC), and keep the existing Playwright `_electron.launch()` E2E test suite running cleanly against every migrated channel.

### Execution Order & Parallelism (Wave 1 — P0 Critical Path)

- **Sequential Start**: `TASK-510` (Initialize Cargo workspace) must finish first, followed immediately by `TASK-511` (`specta` TypeScript contract exporter).
- **Parallel Pair**: Once `TASK-511` lands, `TASK-512` (Electron `ipcMain` $\leftrightarrow$ Rust bridge in `apps/praxis-desktop/main/`) and `TASK-513` (Rust `praxis-host` service router and event bus in `crates/praxis-host`) touch disjoint workspaces and can be built in parallel, joining for the end-to-end Playwright smoke verification.

## Tasks

- `TASK-510` (`Critical`, Sequential Step 1) — Initialize root Cargo workspace and shared lints
- `TASK-511` (`Critical`, Sequential Step 2) — Generate ipcContracts.ts from praxis-contracts Rust types
- `TASK-512` (`Critical`, Parallel Step 3A) — Bridge Electron trustedIpcMain and window.praxis events to Rust host
- `TASK-513` (`Critical`, Parallel Step 3B) — Build praxis-host Rust service container and RPC dispatcher

## Acceptance Criteria

- `cargo check --workspace` and `cargo test --workspace` succeed from the repository root.
- `crates/praxis-contracts` exports `packages/core/src/host/ipcContracts.ts` cleanly and passes `npm run check-types` and `npm run check-core-imports`.
- Electron's `trustedIpcMain` can route migrated IPC channels and push events to and from `crates/praxis-host` while `launchTestApp.ts` (`_electron.launch()`) passes all existing Playwright smoke assertions.

## Dependencies

None

## Comments


