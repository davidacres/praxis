import * as path from 'node:path';
import { app } from 'electron';
import { ProjectStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { ProjectManager } from './projectManager';
import { UnionKeyValueStore, identifyStoredRecord } from './adapters/unionKeyValueStore';
import { getWorkspaceScopes, getActiveWorkspaceId } from './workspaceLocations';

let store: ProjectStore | undefined;
let manager: ProjectManager | undefined;
export function getProjectStore(): ProjectStore {
  store ??= new ProjectStore(new UnionKeyValueStore({
    base: new JsonKeyValueStore(path.join(app.getPath('userData'), 'projects.json')),
    scopes: getWorkspaceScopes,
    unionedKeys: new Set(['praxis.projects.v1']),
    identify: identifyStoredRecord,
    preferredScope: getActiveWorkspaceId
  }));
  return store;
}
export function getProjectManager(): ProjectManager { manager ??= new ProjectManager(getProjectStore()); return manager; }

export function resetProjectStore(): void {
  store = undefined;
  manager = undefined;
}
