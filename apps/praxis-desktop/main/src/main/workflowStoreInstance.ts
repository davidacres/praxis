import * as path from 'node:path';
import { app } from 'electron';
import { WorkflowStore, WorkflowPolicyStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

/**
 * Singleton stores for governed delivery workflows (FX-BF-012).
 *
 * `workflows.json` under `userData` holds global definitions and every policy
 * profile. Project-scoped definitions belong in a project's own
 * `.praxis/workflows` folder and are read from disk, not from here — but the
 * designer also persists an in-progress project definition to this file under a
 * per-project key so a draft survives a restart before it is committed to the
 * folder. Lives under `userData` so `--user-data-dir` isolates the e2e suite.
 */
let store: JsonKeyValueStore | undefined;

function backing(): JsonKeyValueStore {
  if (!store) {
    store = new JsonKeyValueStore(path.join(app.getPath('userData'), 'workflows.json'));
  }
  return store;
}

export function getWorkflowStore(): WorkflowStore {
  return new WorkflowStore(backing());
}

export function getWorkflowPolicyStore(): WorkflowPolicyStore {
  return new WorkflowPolicyStore(backing());
}

/** Key holding the array of draft project-scoped definitions for one project. */
export function projectWorkflowsKey(projectId: string): string {
  return `praxis.projectWorkflows.${projectId}`;
}

export function getWorkflowBackingStore(): JsonKeyValueStore {
  return backing();
}

export function resetWorkflowStore(): void {
  store = undefined;
}
