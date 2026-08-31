import * as path from 'node:path';
import { app } from 'electron';
import { WorkspaceStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { UnionKeyValueStore, identifyStoredRecord } from './adapters/unionKeyValueStore';
import { getWorkspaceScopes } from './workspaceLocations';

let store: WorkspaceStore | undefined;
let base: JsonKeyValueStore | undefined;
const WORKSPACES_KEY = 'praxis.workspaces.v1';

function getBaseStore(): JsonKeyValueStore {
  base ??= new JsonKeyValueStore(path.join(app.getPath('userData'), 'workspaces.json'));
  return base;
}

export function getWorkspaceStore(): WorkspaceStore {
  store ??= new WorkspaceStore(new UnionKeyValueStore({
    base: getBaseStore(),
    scopes: getWorkspaceScopes,
    unionedKeys: new Set([WORKSPACES_KEY]),
    identify: identifyStoredRecord,
    preferredScope: () => undefined
  }));
  return store;
}

/** Creates a workspace record in the app-owned store before optional relocation. */
export function createWorkspaceInAppStore(input: Parameters<WorkspaceStore['create']>[0], appVersion: string) {
  return new WorkspaceStore(getBaseStore()).create(input, appVersion);
}

export function getWorkspaceBaseStore(): JsonKeyValueStore { return getBaseStore(); }

export function resetWorkspaceStore(): void {
  store = undefined;
  base = undefined;
}
