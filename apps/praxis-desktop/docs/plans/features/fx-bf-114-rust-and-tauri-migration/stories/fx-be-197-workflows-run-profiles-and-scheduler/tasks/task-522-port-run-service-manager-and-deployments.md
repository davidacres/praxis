---
**Created:** 2026-11-07T21:21:55.989Z
id: TASK-522
type: Task
status: To Do
---

# Port runServiceManager and deployment target runners

**Status:** To Do
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


