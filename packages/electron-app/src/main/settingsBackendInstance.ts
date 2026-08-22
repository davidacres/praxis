import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { resolveSharedSettingsPath, type SettingsBackend } from '@ticket-manager/core';
import { SharedSettingsBackend } from './adapters/sharedSettingsBackend';

/**
 * Shared settings file location — both the Electron app and the VS Code
 * extension compute this independently so they land on the same file.
 * Computed eagerly so `connectionStoreInstance` (which needs the same path
 * for its underlying `JsonKeyValueStore`) can share it.
 *
 * `TICKET_MANAGER_SETTINGS_PATH` overrides the shared location. It exists for
 * the Playwright e2e suite: `--user-data-dir` isolates Electron's own state
 * but not this file, so without the override every test run would read and
 * write the developer's real settings (and leak test connections into them).
 */
export function getSharedSettingsFilePath(): string {
  const override = process.env.TICKET_MANAGER_SETTINGS_PATH;
  if (override) {
    return override;
  }
  return resolveSharedSettingsPath(process.platform, {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    home: os.homedir()
  });
}

let instance: SettingsBackend | undefined;

/**
 * Singleton settings backend. Performs the one-time migration from
 * `app.getPath('userData')/settings.json` (legacy) to the shared file path so
 * the Electron app and the VS Code extension read/write the same JSON
 * document. Idempotent — if the shared file is already present, the legacy
 * file is left in place for the user to inspect or back up.
 */
export async function initSettingsBackend(): Promise<SettingsBackend> {
  if (instance) {
    return instance;
  }

  const sharedPath = getSharedSettingsFilePath();
  const legacyPath = path.join(app.getPath('userData'), 'settings.json');
  await migrateLegacySettings(legacyPath, sharedPath);

  instance = new SharedSettingsBackend(sharedPath);
  return instance;
}

/** Synchronous accessor — returns the already-initialised singleton. Throws if not yet initialised. */
export function getSettingsBackend(): SettingsBackend {
  if (!instance) {
    throw new Error('Settings backend is not initialised. Call initSettingsBackend() during app startup.');
  }
  return instance;
}

/**
 * One-time copy from the legacy `userData/settings.json` to the shared path,
 * renaming the ConnectionStore keys so they don't collide with the new
 * `connections` settings object. Skips silently if either file already exists
 * (the user has already migrated or has been editing the new file directly).
 */
async function migrateLegacySettings(legacyPath: string, sharedPath: string): Promise<void> {
  let legacyExists = false;
  try {
    await fsp.access(legacyPath);
    legacyExists = true;
  } catch {
    return;
  }
  if (!legacyExists) {
    return;
  }
  try {
    await fsp.access(sharedPath);
    return; // Shared file already present; assume an editor has used the new format.
  } catch {
    // Shared file doesn't exist — proceed with migration.
  }
  let legacyRaw: string;
  try {
    legacyRaw = await fsp.readFile(legacyPath, 'utf8');
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(legacyRaw) as Record<string, unknown>;
  } catch {
    return; // Legacy file is unparseable — leave it alone for inspection.
  }
  await fsp.mkdir(path.dirname(sharedPath), { recursive: true });
  await fsp.writeFile(sharedPath, JSON.stringify(parsed, null, 2), 'utf8');
}
