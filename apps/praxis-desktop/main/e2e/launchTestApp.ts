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
  /** Enable the built-in fixtures for tests that exercise the demo backend. */
  demoMode?: boolean;
  /**
   * Seed and open a minimal workspace so the app boots into the normal shell
   * instead of the Getting Started onboarding screen. Defaults to `true`; pass
   * `false` for tests that exercise the onboarding flow itself.
   */
  workspace?: boolean;
  /**
   * With `workspace`, restore into the New Session composer (the pre-onboarding
   * default landing spot most legacy specs assume). Defaults to `true`; pass
   * `false` to land on the workspace's own default route (Overview / project home).
   */
  openNewSession?: boolean;
}

const ACTIVE_WORKSPACE_KEY = 'praxis-active-workspace';
const LAST_WORKSPACE_ROUTE_KEY = 'praxis-last-workspace-route';

// The app stores a durable route per workspace under
// `praxis-last-workspace-route:<workspaceId>`. The bare key is the legacy
// single slot and is only consulted when a workspace has no route of its own,
// so a spec seeding a route must name the workspace it belongs to.

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
    PRAXIS_SETTINGS_PATH: settingsPath,
    // Full-tools AI sessions require a working folder; give every test profile
    // one (its own isolated user-data dir) unless a test overrides it.
    PRAXIS_AI_WORKING_DIR: userDataDir
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
    args: [
      path.join(__dirname, '..'),
      `--user-data-dir=${userDataDir}`,
      ...(options?.demoMode === false ? [] : ['--demo'])
    ],
    cwd: path.join(__dirname, '..'),
    env
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  if (!options?.keepSplash) {
    await dismissSplash(window);
  }

  if (options?.workspace !== false) {
    await seedWorkspace(window, options?.openNewSession !== false);
    await window.waitForLoadState('domcontentloaded');
    if (!options?.keepSplash) {
      await dismissSplash(window);
    }
  }

  return { electronApp, window, userDataDir, settingsPath };
}

/**
 * Creates (or reuses) a workspace and marks it active, then reloads so the app's
 * startup path restores into it — past the Getting Started screen. With
 * `openNewSession`, also seeds the durable route so it restores into the New
 * Session composer, matching the pre-onboarding default most specs assume.
 */
async function seedWorkspace(window: Page, openNewSession: boolean): Promise<void> {
  await window.evaluate(
    async ({ activeKey, routeKey, openNewSession }) => {
      const existing = await window.praxis.workspaces.list();
      const workspace = existing[0] ?? (await window.praxis.workspaces.create({ name: 'Test Workspace', projectIds: [] }));
      localStorage.setItem(activeKey, workspace.id);
      // Routes are stored per workspace. Clear the legacy slot too, or its
      // fallback would resurrect a route this seeding just cleared.
      localStorage.removeItem(routeKey);
      if (openNewSession) {
        localStorage.setItem(`${routeKey}:${workspace.id}`, JSON.stringify({ newSession: true }));
      } else {
        localStorage.removeItem(`${routeKey}:${workspace.id}`);
      }
    },
    { activeKey: ACTIVE_WORKSPACE_KEY, routeKey: LAST_WORKSPACE_ROUTE_KEY, openNewSession }
  );
  await window.reload();
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
