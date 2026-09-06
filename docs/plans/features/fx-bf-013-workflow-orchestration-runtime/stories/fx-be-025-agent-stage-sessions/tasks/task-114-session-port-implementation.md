---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-114
title: Implement WorkflowSessionPort over the agent hosts
status: complete
story: FX-BE-025
updated: 2026-09-02
dependencies: [FX-BE-020]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-114: Implement WorkflowSessionPort over the agent hosts
## Implement WorkflowSessionPort over the agent hosts
## Goal
Turn a stage context plus a resolved binding into a running agent session,
using the same host machinery `ai:delegate` already drives.
## Done when
- `createStageSession(context, binding)` builds an `AgentTaskDefinition`
  (goal / scope / definitionOfDone from the stage instructions and expected
  outputs), activates the binding's skills, and starts the session via the ACP /
  copilot / gateway host with the binding's tool mode, in the run worktree.
- The session key is deterministic per run and node so a replay or a recovery
  re-attaches rather than forking a second session.
- `cancelStageSession` aborts an active task; `summarizeStageSession` returns the
  session's short outcome for the monitor.
- Preflight (`preflightStage`) is enforced here — a failing binding throws
  before any host call.
## Notes
Reuse `resolveAcpStartOptions` / `resolveCopilotStartOptions` /
`resolveConnectionOptions` and the worktree/skill wiring from the `ai:delegate`
handler.

## Description


## Dependencies



## Comments


