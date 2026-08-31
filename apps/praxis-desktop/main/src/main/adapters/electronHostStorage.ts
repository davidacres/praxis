import * as path from 'node:path';
import { app } from 'electron';
import type { HostStorage } from '@praxis/core';
import { JsonKeyValueStore } from './jsonKeyValueStore';

/**
 * Electron's HostStorage. `workspace` is scoped to a Project id (a generated id for
 * connection-based modes like Demo, or a folder path for folder connections).
 * See plan §2 "Workspace-scope semantics in Electron".
 */
export function createHostStorage(projectId: string): HostStorage {
  const userDataDir = app.getPath('userData');
  return {
    global: new JsonKeyValueStore(path.join(userDataDir, 'global.json')),
    workspace: new JsonKeyValueStore(path.join(userDataDir, 'projects', projectId, 'state.json'))
  };
}
