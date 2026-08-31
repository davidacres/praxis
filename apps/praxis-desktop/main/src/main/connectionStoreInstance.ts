import * as path from 'node:path';
import { app } from 'electron';
import { ConnectionStore } from '@praxis/core';
import { createSettingsStore } from './adapters/electronSettingsStore';
import { ElectronSecretsStore } from './adapters/electronSecretsStore';
import { UnionKeyValueStore, identifyStoredRecord } from './adapters/unionKeyValueStore';
import { getWorkspaceScopes, getActiveWorkspaceId } from './workspaceLocations';

let instance: ConnectionStore | undefined;
let secretsInstance: ElectronSecretsStore | undefined;

/**
 * Shared safeStorage-backed secrets store — one instance over the single
 * `secrets.json` in userData, used by both the ConnectionStore (connection
 * secrets) and the MCP OAuth manager (OAuth clients/tokens/verifiers).
 */
export function getSecretsStore(): ElectronSecretsStore {
  if (!secretsInstance) {
    secretsInstance = new ElectronSecretsStore(path.join(app.getPath('userData'), 'secrets.json'));
  }
  return secretsInstance;
}

/** Shared ConnectionStore singleton — connections/boards in settings.json, secrets safeStorage-encrypted. */
export function getConnectionStore(): ConnectionStore {
  if (!instance) {
    instance = new ConnectionStore(new UnionKeyValueStore({
      base: createSettingsStore(),
      scopes: getWorkspaceScopes,
      unionedKeys: new Set(['connections', 'boards']),
      identify: identifyStoredRecord,
      preferredScope: getActiveWorkspaceId
    }), getSecretsStore());
  }
  return instance;
}
