import * as path from 'node:path';
import { app } from 'electron';
import { ConnectionStore } from '@ticket-manager/core';
import { createSettingsStore } from './adapters/electronSettingsStore';
import { ElectronSecretsStore } from './adapters/electronSecretsStore';

let instance: ConnectionStore | undefined;

/** Shared ConnectionStore singleton — connections/boards in settings.json, secrets safeStorage-encrypted. */
export function getConnectionStore(): ConnectionStore {
  if (!instance) {
    instance = new ConnectionStore(
      createSettingsStore(),
      new ElectronSecretsStore(path.join(app.getPath('userData'), 'secrets.json'))
    );
  }
  return instance;
}
