---
type: Task
id: TASK-146
title: "Integrate Run controls and recovery"
status: planned
story: FX-BE-055
updated: 2026-09-07
dependencies: [TASK-145]
---

# TASK-146: Integrate Run controls and recovery

**Priority:** High
**Created:** 2026-09-07

## Goal

Show service health, live output, start/stop/restart and preview URL; after app restart reconcile owned processes conservatively and label uncertain state.

## Implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-145
## Acceptance criteria

- Electron fixtures exercise multi-service startup, crash and recovery; closing a preview tab does not silently terminate a persistent deployment.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
