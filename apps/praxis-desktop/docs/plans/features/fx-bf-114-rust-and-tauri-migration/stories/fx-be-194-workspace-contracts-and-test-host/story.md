---
**Created:** 2026-11-07T21:20:24.318Z
id: FX-BE-194
type: Story
status: To Do
---

# Cargo Workspace, IPC Contract Codegen, and Playwright Test Host

**Status:** To Do
**Type:** Story
**Priority:** Critical

## Description

Establish the root Cargo workspace (`crates/praxis-*` and `apps/praxis-desktop/src-tauri`), generate TypeScript IPC contracts from Rust definitions so `@praxis/desktop-renderer` stays strictly type-checked via `npm run check-core-imports`, implement the universal `window.praxis` client adapter, and build `praxis-test-host` so Playwright E2E specs run against Chromium and the Rust backend.

### Execution Order & Parallelism (Wave 1 — P0 Critical Path)

- **Sequential Start**: `TASK-510` (Initialize Cargo workspace) must finish first, followed immediately by `TASK-511` (`specta` TypeScript contract exporter).
- **Parallel Pair**: Once `TASK-511` lands, `TASK-512` (TypeScript `installPraxisBridge.ts` in `apps/praxis-desktop/renderer/src/host/`) and `TASK-513` (Rust `praxis-test-host` server in `crates/praxis-host`) touch disjoint workspaces and can be built in parallel, joining only for the final `launchTestApp.ts` smoke verification.

## Tasks

- `TASK-510` (`Critical`, Sequential Step 1) — Initialize root Cargo workspace and shared lints
- `TASK-511` (`Critical`, Sequential Step 2) — Generate ipcContracts.ts from praxis-contracts Rust types
- `TASK-512` (`Critical`, Parallel Step 3A) — Implement Tauri and WebSocket window.praxis renderer adapter
- `TASK-513` (`Critical`, Parallel Step 3B) — Build praxis-test-host loopback server for Playwright E2E

## Acceptance Criteria

- `cargo check --workspace` and `cargo test --workspace` succeed from the repository root.
- `crates/praxis-contracts` exports `packages/core/src/host/ipcContracts.ts` cleanly and passes `npm run check-types` and `npm run check-core-imports`.
- `launchTestApp.ts` can boot `praxis-test-host` and execute Playwright E2E assertions against `window.praxis` in Chromium.

## Dependencies

None

## Comments


