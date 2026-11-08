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
- 2026-11-08: Verified `run_service_manager` readiness probes (HTTP, TCP, LogLine, None settle delay) and process exit lifecycle (pre-ready exit capture, unexpected exit after ready, graceful process-group SIGTERM/SIGKILL termination) in `crates/praxis-workflows`. All unit and integration tests in `cargo test -p praxis-workflows` pass and `cargo clippy --all-targets --all-features -- -D warnings` is clean.

- 2026-11-08: The direct deployment path is ported, in three commits (`e2d30e36`, `c4dbc6fa` and the orchestrator commit after them). `crates/praxis-workflows` now has:
  - `deployment_profile`: the schema. Validation reads the raw JSON, as `deploymentProfile.ts` does, so an unknown kind or a fractional version is reported as an issue rather than failing to parse.
  - `deployment_profile_store`: `.praxis/deployments/*.deployment.praxis.json` storage and credential rebinding.
  - `publish_manifest`: digests byte-compatible with the TypeScript. Files are ordered by UTF-16 code units, and the fixture digests were checked against `packages/core`'s `buildPublishManifest` output.
  - `deployment_run_state`: the reducer, approval binding and target locks.
  - `deployment_run_store`: the key-value run list and crash reconciliation.
  - `directory_target`, `direct_process_executor` and `direct_deployment_orchestrator`.
  - `network_probe` and `process_tree`, extracted from `run_service_manager` so the service manager and the deploy code share them, as `host/networkProbe.ts` and `host/processTree.ts` are shared in the TypeScript.
- Tests: 95 new unit tests port the TypeScript cases, plus `tests/direct_delivery_journey.rs` (the build, publish, deploy, failed health, rollback journey). The process tests use `/bin/sh` instead of node. Five consecutive `cargo test --workspace` runs passed (626 tests), and `npm run check:rust` is clean.
- Deliberate differences from the TypeScript:
  - The orchestrator takes the store and lock registry behind `std::sync::Mutex`, locked only per read or write and never across an await, so deploys to different targets still run concurrently.
  - The target lock is released on every path. `directDeploymentOrchestrator.ts` leaks it if a save throws mid-deploy.
  - The `isAlive` and secret `lookup` seams are synchronous.
- Still open: `githubActionsExecutor`, `githubActionsObserver`, `githubActionsResults` and `githubActionsOrchestrator` need the GitHub REST client from TASK-518. No `deployments:*` or `runs:*` channel is routed to `praxis-host` yet; that waits on the FX-BE-203 cutover gate.
