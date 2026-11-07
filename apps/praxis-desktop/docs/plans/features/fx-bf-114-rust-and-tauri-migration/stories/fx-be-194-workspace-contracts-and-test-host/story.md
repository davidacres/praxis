---
**Created:** 2026-11-07T21:20:24.318Z
id: FX-BE-194
type: Story
status: To Do
---

# Cargo Workspace, IPC Contract Codegen, and Playwright Test Host

**Status:** To Do
**Type:** Story
**Priority:** High

## Description

Establish the root Cargo workspace (`crates/praxis-*` and `apps/praxis-desktop/src-tauri`), generate TypeScript IPC contracts from Rust definitions so `@praxis/desktop-renderer` stays strictly type-checked via `npm run check-core-imports`, implement the universal `window.praxis` client adapter, and build `praxis-test-host` so Playwright E2E specs run against Chromium and the Rust backend.

## Tasks

- `TASK-510` — Initialize root Cargo workspace and shared lints
- `TASK-511` — Generate ipcContracts.ts from praxis-contracts Rust types
- `TASK-512` — Implement Tauri and WebSocket window.praxis renderer adapter
- `TASK-513` — Build praxis-test-host loopback server for Playwright E2E

## Acceptance Criteria

- `cargo check --workspace` and `cargo test --workspace` succeed from the repository root.
- `crates/praxis-contracts` exports `packages/core/src/host/ipcContracts.ts` cleanly and passes `npm run check-types` and `npm run check-core-imports`.
- `launchTestApp.ts` can boot `praxis-test-host` and execute Playwright E2E assertions against `window.praxis` in Chromium.

## Dependencies

None

## Comments


