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
 * - `PRAXIS_SETTINGS_PATH` points the settings backend (which the
 *   connection store shares) at a throwaway file inside that profile.
 *
 * Without the second piece the suite reads and writes the real shared
 * settings file (`%APPDATA%\praxis\settings.json`) — tests used to
 * leak `e2e-*` connections into it and fail depending on what the developer
 * had configured. `seedSettings` pre-populates the per-test file.
 *
 * `reuse` relaunches into an earlier test app's profile (same user-data dir
 * and settings file) so persistence tests can verify state survives a
 * restart; callers then close the intermediate app with `electronApp.close()`
 * only, letting `closeTestApp` clean the profile up after the final launch.
 */
export interface LaunchOptions {
  /**
   * Leave the startup splash on screen. Only for the handful of tests that
   * assert on the splash itself — every other test wants it out of the way.
   */
  keepSplash?: boolean;
}

export async function launchTestApp(
  seedSettings?: Record<string, unknown>,
  reuse?: { userDataDir: string; settingsPath: string },
  extraEnv?: Record<string, string | undefined>,
  options?: LaunchOptions
): Promise<TestApp> {
  const userDataDir = reuse?.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-e2e-'));
  const settingsPath = reuse?.settingsPath ?? path.join(userDataDir, 'test-settings.json');
  if (seedSettings) {
    fs.writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2));
  }

  const env: Record<string, string> = {
    ...process.env,
    PRAXIS_SETTINGS_PATH: settingsPath
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
  if (!options?.keepSplash) {
    await dismissSplash(window);
  }
  return { electronApp, window, userDataDir, settingsPath };
}

/**
 * The splash animates for ~7.8s before it retires itself, which every test
 * would otherwise pay on launch. Clicking it skips straight to the 420ms fade,
 * which is the same escape hatch a real user has.
 *
 * Deliberately forgiving: the splash is skipped entirely under reduced motion,
 * and may have finished on its own if the machine was slow to hand us the
 * window — either way the goal is simply "no splash", so a miss is not a
 * failure.
 */
export async function dismissSplash(window: Page): Promise<void> {
  const splash = window.locator('[data-testid="startup-splash"]');
  try {
    await splash.click({ timeout: 4000 });
  } catch {
    // Already gone, or never rendered.
  }
  await splash.waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
}

export async function closeTestApp(app: TestApp): Promise<void> {
  await app.electronApp.close();
  fs.rmSync(app.userDataDir, { recursive: true, force: true });
}
