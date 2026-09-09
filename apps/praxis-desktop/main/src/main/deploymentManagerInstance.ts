import * as path from 'node:path';
import { app } from 'electron';
import { DeploymentRunStore, DeploymentTargetLockRegistry } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

/**
 * Singleton state for direct deployment runs (FX-BE-059 / TASK-158) —
 * `deploymentRuns.json` under `userData`, the same convention
 * `workflowStoreInstance.ts` uses for `workflows.json`, so `--user-data-dir`
 * isolates this the same way for the e2e suite.
 *
 * `DeploymentTargetLockRegistry` is in-memory only and process-lifetime —
 * a lock held when the app quits mid-deploy does not need to survive a
 * restart, because a restart's own recovery path is
 * `DeploymentRunStore.needingReconciliation()` (TASK-154), not a resumed
 * lock; a run reconciled to `unknown` releases nothing here automatically
 * (a known, documented limitation from TASK-154's own evidence), but a
 * fresh `DeploymentTargetLockRegistry` after a restart holds no stale
 * holder either, so nothing is left permanently locked out by a crash.
 */
let store: JsonKeyValueStore | undefined;
let locks: DeploymentTargetLockRegistry | undefined;

function backing(): JsonKeyValueStore {
  if (!store) {
    store = new JsonKeyValueStore(path.join(app.getPath('userData'), 'deploymentRuns.json'));
  }
  return store;
}

export function getDeploymentRunStore(): DeploymentRunStore {
  return new DeploymentRunStore(backing());
}

export function getDeploymentTargetLocks(): DeploymentTargetLockRegistry {
  if (!locks) locks = new DeploymentTargetLockRegistry();
  return locks;
}

export function resetDeploymentManager(): void {
  store = undefined;
  locks = undefined;
}
