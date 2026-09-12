---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-183
title: "Implement protocol and lifecycle"
status: To Do
story: FX-BE-068
updated: 2026-09-07
dependencies: [FX-BE-067]
---

# TASK-183: Implement protocol and lifecycle

**Priority:** High
**Created:** 2026-09-07

## Goal

Handle framing, request IDs, timeouts, adapter events, cancellation, launch/attach and termination; own adapter processes and explicitly distinguish detach from stopping a debuggee.

## Implementation entry points

main/src/main/debugging (new); packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-067
## Acceptance criteria

- Scripted DAP fixture covers malformed response, out-of-order events, crash and disconnect; attached processes survive detach when configured.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


