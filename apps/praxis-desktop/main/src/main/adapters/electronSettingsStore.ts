import type { KeyValueStore } from '@praxis/core';
import { JsonKeyValueStore } from './jsonKeyValueStore';
import { getSharedSettingsFilePath } from '../settingsBackendInstance';

/**
 * The connection/board store's underlying KV file. Points at the shared
 * platform-specific settings path so the Electron app and the VS Code
 * extension see the same value. Migrated once at startup from
 * `app.getPath('userData')/settings.json` by `initSettingsBackend`.
 */
export function createSettingsStore(): KeyValueStore {
  return new JsonKeyValueStore(getSharedSettingsFilePath());
}
