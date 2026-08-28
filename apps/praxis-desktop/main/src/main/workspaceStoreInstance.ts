import * as path from 'node:path';
import { app } from 'electron';
import { WorkspaceStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let store: WorkspaceStore | undefined;
export function getWorkspaceStore(): WorkspaceStore {
  store ??= new WorkspaceStore(new JsonKeyValueStore(path.join(app.getPath('userData'), 'workspaces.json')));
  return store;
}
