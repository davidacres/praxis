import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

export interface TestApp {
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
  /** Per-test settings file the app reads/writes instead of the real shared one. */
  settingsPath: string;
}

/**
 * Launches the app fully isolated from the developer's machine:
 *
 * - `--user-data-dir` gives Electron a throwaway profile, and
 * - `TICKET_MANAGER_SETTINGS_PATH` points the settings backend (which the
 *   connection store shares) at a throwaway file inside that profile.
 *
 * Without the second piece the suite reads and writes the real shared
 * settings file (`%APPDATA%\ticket-manager\settings.json`) — tests used to
 * leak `e2e-*` connections into it and fail depending on what the developer
 * had configured. `seedSettings` pre-populates the per-test file.
 *
 * `reuse` relaunches into an earlier test app's profile (same user-data dir
 * and settings file) so persistence tests can verify state survives a
 * restart; callers then close the intermediate app with `electronApp.close()`
 * only, letting `closeTestApp` clean the profile up after the final launch.
 */
export async function launchTestApp(
  seedSettings?: Record<string, unknown>,
  reuse?: { userDataDir: string; settingsPath: string },
  extraEnv?: Record<string, string | undefined>
): Promise<TestApp> {
  const userDataDir = reuse?.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-e2e-'));
  const settingsPath = reuse?.settingsPath ?? path.join(userDataDir, 'test-settings.json');
  if (seedSettings) {
    fs.writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2));
  }

  const env: Record<string, string> = {
    ...process.env,
    TICKET_MANAGER_SETTINGS_PATH: settingsPath
  } as Record<string, string>;
  // Per-test env overrides; `undefined` deletes a variable so a developer's
  // real credentials (e.g. AI_GATEWAY_API_KEY) can't leak into a test.
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    cwd: path.join(__dirname, '..'),
    env
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, userDataDir, settingsPath };
}

export async function closeTestApp(app: TestApp): Promise<void> {
  await app.electronApp.close();
  fs.rmSync(app.userDataDir, { recursive: true, force: true });
}
