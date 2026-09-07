---
type: Story
id: FX-BE-067
title: "Debugger contracts and adapter capability proof"
status: planned
feature: FX-BF-026
updated: 2026-09-07
dependencies: [FX-BF-022]
---

# FX-BE-067: Debugger contracts and adapter capability proof

**Priority:** High
**Created:** 2026-09-07

## Outcome

Validate DAP adapter capabilities and distribution requirements before committing to a debugger implementation.

## Scope and implementation entry points

packages/core/src/debugging (new); main/src/main. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-022
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-180](tasks/task-180-define-debug-session-model.md) | Define debug session model |
| 2 | [TASK-181](tasks/task-181-prove-node-and-net-adapter-choices.md) | Prove Node and .NET adapter choices |
| 3 | [TASK-182](tasks/task-182-define-trusted-adapter-configuration.md) | Define trusted adapter configuration |

## Acceptance criteria

- Contracts reject stale frame references after resume and cross-session object IDs; paused, running, disconnected and terminated are distinct.
- Record exact versions, launch/attach and source-map results, distribution decision and unsupported capabilities; do not assume Microsoft debugger redistribution rights.
- Unsupported runtime or adapter blocks preflight with a reason; workspace configuration cannot silently download or execute an untrusted adapter.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
