import * as path from 'node:path';
import { app } from 'electron';
import type { KeyValueStore } from '@ticket-manager/core';
import { JsonKeyValueStore } from './jsonKeyValueStore';

/** Electron's settings.json under userData — backs ConnectionStore's `connections`/`boards` keys. */
export function createSettingsStore(): KeyValueStore {
  return new JsonKeyValueStore(path.join(app.getPath('userData'), 'settings.json'));
}
