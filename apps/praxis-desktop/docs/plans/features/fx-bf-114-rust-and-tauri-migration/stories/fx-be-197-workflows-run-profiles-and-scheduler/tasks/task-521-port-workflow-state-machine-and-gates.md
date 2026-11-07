---
**Created:** 2026-11-07T21:21:54.941Z
id: TASK-521
type: Task
status: To Do
---

# Port workflow stage state machine, gates, and check runner

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port `workflowOrchestrator.ts`, `stageModel.ts`, `workflowGates.ts`, `workflowThresholdGates.ts`, `workflowMultiOwnerGates.ts`, `workflowLoops.ts`, `reviewFixLoop.ts`, `checkPresets.ts`, `checkFindings.ts`, and `workflowCheckProcess.ts` into `crates/praxis-workflows`. Use `tokio::process` with Unix process groups (`killpg`) and Windows Job Objects to ensure spawned check processes and child trees terminate cleanly on cancellation.

## Acceptance Criteria

- All workflow state machine, gate, loop, waiver register, and check finding unit tests pass in `cargo test -p praxis-workflows`.
- `workflowStage.spec.ts`, `workflowGates.spec.ts`, and `workflowChecks.spec.ts` pass.

## Dependencies

- `FX-BE-195`

## Comments


