---
**Created:** 2026-11-07T21:20:26.706Z
id: TASK-511
type: Task
status: To Do
---

# Generate ipcContracts.ts from praxis-contracts Rust types

**Status:** To Do
**Type:** Task
**Priority:** Critical

## Description

Define the shared IPC request, response, event payload, and domain data structures in `crates/praxis-contracts` using `serde` and `specta::Type`. Build a binary target (`cargo run -p praxis-contracts --bin export-types`) that emits TypeScript definitions compatible with `packages/core/src/host/ipcContracts.ts` and `PraxisIpc`.

## Acceptance Criteria

- Running the exporter updates `ipcContracts.ts` deterministically with zero manual edits required.
- `npm run check-core-imports` and `npm run check-types` pass across `@praxis/desktop-renderer`.

## Dependencies

- `TASK-510`

## Comments


