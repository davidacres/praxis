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
 */
export async function launchTestApp(seedSettings?: Record<string, unknown>): Promise<TestApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-e2e-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  if (seedSettings) {
    fs.writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2));
  }

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TICKET_MANAGER_SETTINGS_PATH: settingsPath }
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, userDataDir, settingsPath };
}

export async function closeTestApp(app: TestApp): Promise<void> {
  await app.electronApp.close();
  fs.rmSync(app.userDataDir, { recursive: true, force: true });
}
