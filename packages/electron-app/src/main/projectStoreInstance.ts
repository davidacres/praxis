import * as path from 'node:path';
import { app } from 'electron';
import { ProjectStore } from '@ticket-manager/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { ProjectManager } from './projectManager';

let store: ProjectStore | undefined;
let manager: ProjectManager | undefined;
export function getProjectStore(): ProjectStore {
  store ??= new ProjectStore(new JsonKeyValueStore(path.join(app.getPath('userData'), 'projects.json')));
  return store;
}
export function getProjectManager(): ProjectManager { manager ??= new ProjectManager(getProjectStore()); return manager; }
