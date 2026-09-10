---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-068
title: "DAP service and Node TypeScript debugging"
status: planned
feature: FX-BF-026
updated: 2026-09-07
dependencies: [FX-BE-067]
---

# FX-BE-068: DAP service and Node TypeScript debugging

**Priority:** High
**Created:** 2026-09-07

## Outcome

Implement a main-process DAP client and session lifecycle, with Node/TypeScript as the first supported vertical slice.

## Scope and implementation entry points

main/src/main/debugging (new); packages/core/src/host/ipcContracts.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-067
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-183](tasks/task-183-implement-protocol-and-lifecycle.md) | Implement protocol and lifecycle |
| 2 | [TASK-184](tasks/task-184-implement-breakpoints-and-inspection.md) | Implement breakpoints and inspection |
| 3 | [TASK-185](tasks/task-185-expose-typed-debugger-ipc.md) | Expose typed debugger IPC |

## Acceptance criteria

- Scripted DAP fixture covers malformed response, out-of-order events, crash and disconnect; attached processes survive detach when configured.
- Node TypeScript fixture stops at the expected source location and exposes expected variables; stale references fail safely after continue.
- Renderer cannot send arbitrary raw adapter commands; multiple sessions stay isolated and unsupported operations are visibly unavailable.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


