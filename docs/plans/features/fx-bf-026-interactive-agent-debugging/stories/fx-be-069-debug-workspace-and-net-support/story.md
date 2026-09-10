---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-069
title: "Debug workspace and .NET support"
status: planned
feature: FX-BF-026
updated: 2026-09-07
dependencies: [FX-BE-068]
---

# FX-BE-069: Debug workspace and .NET support

**Priority:** High
**Created:** 2026-09-07

## Outcome

Provide focused debug controls in Praxis without introducing a full code editor; add a validated .NET adapter.

## Scope and implementation entry points

renderer/src/debugging (new); main/src/main/debugging. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-068
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-186](tasks/task-186-build-debugging-surface.md) | Build debugging surface |
| 2 | [TASK-187](tasks/task-187-integrate-net-launch-and-attach.md) | Integrate .NET launch and attach |
| 3 | [TASK-188](tasks/task-188-verify-interactive-workflows.md) | Verify interactive workflows |

## Acceptance criteria

- Keyboard and themed captures cover running, paused, unavailable source and disconnected sessions; no editable source buffer is introduced.
- A C# fixture launches, stops at a breakpoint, exposes locals and detaches correctly; missing symbols and unsupported runtime produce actionable states.
- Both language journeys have recorded evidence; breakpoints and variables cannot accidentally leak between projects or revive stale paused state.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


