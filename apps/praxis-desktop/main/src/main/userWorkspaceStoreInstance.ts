import * as path from 'node:path';
import { app } from 'electron';
import { UserWorkspaceStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let instance: UserWorkspaceStore | undefined;

/**
 * Singleton store of user-workspace board definitions, backed by
 * `userData/userWorkspace.json`. Global (not per-connection), mirroring the
 * extension's `context.globalState`-backed store. Resolved lazily so the
 * per-test `userData` override in e2e launches is already in effect.
 */
export function getUserWorkspaceStore(): UserWorkspaceStore {
  if (!instance) {
    instance = new UserWorkspaceStore(
      new JsonKeyValueStore(path.join(app.getPath('userData'), 'userWorkspace.json'))
    );
  }
  return instance;
}
