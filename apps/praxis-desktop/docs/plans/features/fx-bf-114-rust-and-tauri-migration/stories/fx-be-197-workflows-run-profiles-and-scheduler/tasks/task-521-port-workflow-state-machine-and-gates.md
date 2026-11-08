---
**Created:** 2026-11-07T21:21:54.941Z
id: TASK-521
type: Task
status: Done
---

# Port workflow stage state machine, gates, and check runner

**Status:** Done
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

- 2026-11-08: Done, in four commits. `crates/praxis-workflows` now has `types`, `waivers`, `stage_model`, `check_presets`, `edges`, `run`, `scheduler`, `stage_session` (`find_snapshot`), `gates`, `recovery`, `orchestrator` (tokio, async_trait ports) and `check_process` (process-group SIGTERM→SIGKILL via `nix::killpg`, `taskkill /T /F` on Windows, allow-listed env).
- Verification: `tests/run_parity.rs` replays 54 seeded random + scripted scenarios that `tests/parity/generate-run-parity.mjs` drove through the compiled TS engine and requires identical schedules, statuses, loops, gate evaluations (with and without a policy), next actions, timeouts, failing findings and final runs at every step; mutation checks confirmed it catches a one-word divergence. `tests/orchestrator.rs` ports all 33 `workflowOrchestrator.test.ts` behaviours (stable over 10 runs); `check_process` ports the `workflowCheckProcess.test.ts` cases.
- Scope notes: `workflowThresholdGates`, `workflowMultiOwnerGates`, `workflowLoops`, `reviewFixLoop` and `checkFindings` exist only as TS test files — their behaviour lives in gates/edges/run and is covered by the parity harness. The named e2e specs (`workflowStage`, `workflowGates`, `workflowChecks`) do not exist, and no app path calls the Rust engine yet, so Playwright cannot exercise it; that becomes possible when the `workflow:*` IPC channels move to `praxis-host`. The check runner takes its environment as an argument instead of enriching the global PATH (`ensureEnvironmentPath` stays a host concern), and spawn-failure messages use Rust's io error text.
