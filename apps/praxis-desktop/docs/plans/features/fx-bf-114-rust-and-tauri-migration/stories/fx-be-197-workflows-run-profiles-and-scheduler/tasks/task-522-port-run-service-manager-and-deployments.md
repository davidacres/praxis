---
**Created:** 2026-11-07T21:21:55.989Z
id: TASK-522
type: Task
status: In Progress
---

# Port runServiceManager and deployment target runners

**Status:** In Progress
**Type:** Task
**Priority:** High

## Description

Port `runProfileDiscovery.ts`, `runProfileStore.ts`, `runServiceManager.ts`, `runReconciliation.ts`, `previewVerification.ts`, and `packages/core/src/deployments/` (`directDeploymentOrchestrator`, `githubActionsOrchestrator`, `directoryTarget`) to `crates/praxis-workflows`. Support managed dev-server lifecycles, port readiness probing, log ring buffers, and orphan PID reconciliation across restarts.

## Acceptance Criteria

- `runServiceManager`, `runReconciliation`, and `deployments` unit tests pass in `cargo test -p praxis-workflows`.
- `managedRunAndPreview.spec.ts` and deployment E2E specs pass.

## Dependencies

- `TASK-521`

## Comments
- 2026-11-08: Partially done, in three commits (`f95265e7`, `7731cee9`, and the previews commit that follows). `crates/praxis-workflows` now has `run_profile` (validation, parse and serialize), `run_profile_store` and `run_profile_discovery` (`package.json` and `launchSettings.json` proposals), `run_reconciliation` (run-state persistence and pid liveness), `run_service_manager` (tokio supervisor per service: readiness via none, log-line, tcp and http probes; dependency waits; timeout; per-service start, stop and restart; process-group SIGTERM then SIGKILL) and `preview_verification` (assertions, outcome, failure context). Verified with 47 + 19 + 12 new tests (`cargo test -p praxis-workflows`), clippy `-D warnings`, `npm run check-types` and `npm run test:rust` all passing.
- Not done: `directoryTarget`, `directDeploymentOrchestrator`, `directProcessExecutor`, and `githubActions*` under `packages/core/src/deployments/`. The direct orchestrator depends on the deployment-profile model, which is not ported yet, and the GitHub Actions path needs the GitHub client from TASK-518. `managedRunAndPreview.spec.ts` and the deployment E2E specs cannot run yet because no `run:*` or `deployments:*` channel is routed to `praxis-host`.
- Parity: the run-profile and service-manager tests are ported TS cases, not a generated cross-runtime fixture like TASK-521's. Process-lifecycle behaviour is timing-based. The service-manager tests passed on five consecutive runs.

