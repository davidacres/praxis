import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

export interface TestApp {
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
  /** Per-test settings file the app reads/writes instead of the real shared one. */
  settingsPath: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
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
  /**
   * Leave the first-run AI setup wizard in place. By default the profile is
   * marked as already past it (`praxis-ai-onboarded`), as the wizard would
   * otherwise stand in front of every spec; pass `true` to exercise it.
   */
  aiOnboarding?: boolean;
  /** Opt in only for tests of discovering CLI agents installed on PATH. */
  discoverInstalledCli?: boolean;
  /** Opt in to exercise the first-run workflow designer tutorial. Defaults to false. */
  workflowTutorial?: boolean;
  /** Opt in to exercise the semantic search recommendation prompt on startup. Defaults to false. */
  semanticSearchPrompt?: boolean;
  /** Opt in to the "build a code index?" prompt for an unindexed project folder. Defaults to false. */
  codeIndexPrompt?: boolean;
}

const AI_ONBOARDED_KEY = 'praxis-ai-onboarded';
const WORKFLOW_TUTORIAL_KEY = 'praxis-workflow-tutorial-seen';
const ACTIVE_WORKSPACE_KEY = 'praxis-active-workspace';
const LAST_WORKSPACE_ROUTE_KEY = 'praxis-last-workspace-route';
const SEMANTIC_SEARCH_DISMISS_KEY = 'praxis:semantic-search-prompt-dismissed';
const SEMANTIC_SEARCH_UPDATE_DISMISS_KEY = 'praxis:semantic-search-update-dismissed';
/** "Not now" for every folder (CodeIntelTitlebarChip's INDEX_PROMPT_DISMISS_PREFIX + '*'). */
const CODE_INDEX_PROMPT_OFF_KEY = 'praxis:code-index-prompt-dismissed:*';

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
  const freeMobilePort = reuse ? undefined : await findFreePort();
  if (!reuse || seedSettings) {
    const isolatedProviders = options?.discoverInstalledCli ? {} : Object.fromEntries(
      ['claude-code-cli', 'codex-cli', 'copilot-cli', 'antigravity-cli', 'cursor-cli'].map(id => [id, { cliPath: path.join(userDataDir, 'missing-cli') }])
    );
    const seedAi = (seedSettings?.ai ?? {}) as Record<string, unknown>;
    seedSettings = {
      notifications: { completed: false, failed: false, needsAttention: false },
      ...seedSettings,
      ai: { workingDirectory: userDataDir, ...seedAi, providers: { ...isolatedProviders, ...((seedAi.providers ?? {}) as Record<string, unknown>) } }
    };
    const mergedSettings = freeMobilePort && !seedSettings.mobileAccess
      ? { ...seedSettings, mobileAccess: { listenPort: freeMobilePort } }
      : seedSettings;
    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2));
  }

  const env: Record<string, string> = {
    ...process.env,
    PRAXIS_SETTINGS_PATH: settingsPath,
    ...(freeMobilePort ? { PRAXIS_MOBILE_PORT: String(freeMobilePort) } : {}),
    // Full-tools AI sessions require a working folder; give every test profile
    // one (its own isolated user-data dir) unless a test overrides it.
    PRAXIS_AI_WORKING_DIR: userDataDir,
    // Other AI tools' user-level folders (~/.claude, ~/.codex, …) are read from
    // here, so a developer's real home never leaks into a test.
    PRAXIS_NATIVE_SOURCES_HOME: userDataDir,
    // The coordination broker is shared by every Praxis on the machine; a test
    // gets its own, so it never joins (or blocks) a developer's live sessions.
    PRAXIS_COORDINATION_ROOT: path.join(userDataDir, 'coordination')
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
  testAppProcesses.set(electronApp, electronApp.process());
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  if (!options?.keepSplash) {
    await dismissSplash(window);
  }

  const skipAiOnboarding = options?.aiOnboarding !== true;
  const skipWorkflowTutorial = options?.workflowTutorial !== true;
  const skipSemanticSearchPrompt = options?.semanticSearchPrompt !== true;
  const indexPromptOffKey = options?.codeIndexPrompt === true ? '' : CODE_INDEX_PROMPT_OFF_KEY;
  if (options?.workspace !== false) {
    await seedWorkspace(window, options?.openNewSession !== false, skipAiOnboarding, skipWorkflowTutorial, skipSemanticSearchPrompt, indexPromptOffKey);
    await window.waitForLoadState('domcontentloaded');
    if (!options?.keepSplash) {
      await dismissSplash(window);
    }
  } else if (skipAiOnboarding || skipSemanticSearchPrompt || indexPromptOffKey) {
    await window.evaluate(
      ({ aiKey, skipAiOnboarding, wfKey, skipWorkflowTutorial, searchKey, searchUpdateKey, skipSemanticSearchPrompt, indexPromptOffKey }) => {
        if (indexPromptOffKey) localStorage.setItem(indexPromptOffKey, 'true');
        if (skipAiOnboarding) localStorage.setItem(aiKey, '1');
        if (skipWorkflowTutorial) localStorage.setItem(wfKey, '1');
        if (skipSemanticSearchPrompt) { localStorage.setItem(searchKey, 'true'); localStorage.setItem(searchUpdateKey, 'true'); }
      },
      { aiKey: AI_ONBOARDED_KEY, skipAiOnboarding, wfKey: WORKFLOW_TUTORIAL_KEY, skipWorkflowTutorial, searchKey: SEMANTIC_SEARCH_DISMISS_KEY, searchUpdateKey: SEMANTIC_SEARCH_UPDATE_DISMISS_KEY, skipSemanticSearchPrompt, indexPromptOffKey }
    );
    await window.reload();
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
async function seedWorkspace(
  window: Page,
  openNewSession: boolean,
  skipAiOnboarding: boolean,
  skipWorkflowTutorial: boolean,
  skipSemanticSearchPrompt: boolean,
  indexPromptOffKey: string
): Promise<void> {
  await window.evaluate(
    async ({ activeKey, routeKey, openNewSession, aiKey, skipAiOnboarding, wfKey, skipWorkflowTutorial, searchKey, searchUpdateKey, skipSemanticSearchPrompt, indexPromptOffKey }) => {
      if (indexPromptOffKey) localStorage.setItem(indexPromptOffKey, 'true');
      if (skipAiOnboarding) localStorage.setItem(aiKey, '1');
      if (skipWorkflowTutorial) localStorage.setItem(wfKey, '1');
      if (skipSemanticSearchPrompt) { localStorage.setItem(searchKey, 'true'); localStorage.setItem(searchUpdateKey, 'true'); }
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
    {
      activeKey: ACTIVE_WORKSPACE_KEY,
      routeKey: LAST_WORKSPACE_ROUTE_KEY,
      openNewSession,
      aiKey: AI_ONBOARDED_KEY,
      skipAiOnboarding,
      wfKey: WORKFLOW_TUTORIAL_KEY,
      skipWorkflowTutorial,
      searchKey: SEMANTIC_SEARCH_DISMISS_KEY,
      searchUpdateKey: SEMANTIC_SEARCH_UPDATE_DISMISS_KEY,
      skipSemanticSearchPrompt,
      indexPromptOffKey
    }
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

/**
 * Expands every collapsed child-ticket stack on the current board. Child
 * cards render behind a stack face until clicked (see `BoardView.renderStack`),
 * so a fixture with a parent+child pair needs this before any locator can see
 * the child card by its text.
 */
export async function expandAllIssueStacks(window: Page): Promise<void> {
  // `count()` reads the DOM as it is *right now* — it does not wait — so
  // called immediately after a navigation click it can see zero cards and
  // return having done nothing. Wait for the board to render something first.
  await window
    .locator('[data-testid="issue-card"], [data-testid="issue-card-stack"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => undefined);
  const stacks = window.locator('[data-testid="issue-card-stack"][aria-expanded="false"]');
  // Clicking one stack re-renders the column, which can shift which stacks
  // remain collapsed — always take the first match rather than iterating by
  // a count captured before any clicks happened.
  while (await stacks.count()) {
    await stacks.first().click();
  }
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const testAppProcesses = new WeakMap<ElectronApplication, ChildProcess>();

/** A forced exit cleans up isolation, but still fails verification. */
export async function closeTestApp(app: TestApp, options: { timeoutMs?: number } = {}): Promise<void> {
  // Playwright releases the process handle when its application closes.
  const child = testAppProcesses.get(app.electronApp) ?? app.electronApp.process();
  testAppProcesses.set(app.electronApp, child);
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  // Subscribe before requesting shutdown so even an immediate exit is observed.
  let onExit: () => void;
  const exited = new Promise<void>(resolve => { onExit = resolve; });
  child.once('exit', onExit!);
  if (hasExited()) onExit!();
  let stage = 'stopping test-owned work';
  let shutdownError: unknown;
  try {
    await withinDeadline((async () => {
      if (hasExited()) return;
      await stopTestWork(app);
      stage = 'closing Electron';
      await app.electronApp.close();
      stage = 'waiting for the Electron process to exit';
      await exited;
    })(), options.timeoutMs ?? 10000, () => `Test app shutdown timed out while ${stage} (pid ${child.pid})`);
  } catch (error) {
    shutdownError = error;
    if (!hasExited()) {
      // Only this launch's child process; never kill other Praxis instances.
      child.kill('SIGKILL');
      await withinDeadline(exited, 5000, () => `Test app process ${child.pid} did not exit after SIGKILL; profile retained at ${app.userDataDir}`);
    }
  } finally {
    child.removeListener('exit', onExit!);
    // Never remove files while Electron could still be using them. macOS can
    // still be flushing the profile right after the process exits, which fails
    // the delete with ENOTEMPTY, so retry briefly before keeping the directory.
    if (hasExited()) removeProfile(app.userDataDir);
  }
  if (shutdownError) {
    throw new Error(`Test app cleanup failed while ${stage} (pid ${child.pid}); process exited and profile removed`, { cause: shutdownError });
  }
}

/**
 * Deletes a test profile after its Electron process has exited. Retries briefly:
 * macOS can still be writing into the directory for a moment after exit, and
 * that surfaces as ENOTEMPTY, which would otherwise fail an otherwise green test.
 */
function removeProfile(userDataDir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`Could not remove test profile ${userDataDir}; leaving it in place`, error);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

async function stopTestWork(app: TestApp): Promise<void> {
  // Failed assertions can leave a task awaiting approval. End test-owned work
  // before closing, so the application's active-session close guard can settle.
  if (!app.window.isClosed()) {
    await app.window.evaluate(async () => {
      const projects = await window.praxis.projects.list();
      const runs = (await Promise.all(projects.map(project => window.praxis.workflows.listRuns(project.id)))).flat();
      await Promise.all(runs.filter(run => ['running', 'awaiting-approval'].includes(run.status))
        .map(run => window.praxis.workflows.cancelRun(run.runId, 'Test teardown')));
      const sessions = await window.praxis.ai.listSessions();
      await Promise.all(sessions.map(async session => {
        if (session.conversation?.state === 'running') await window.praxis.ai.stopConversation(session.issueKey);
        // ACP publishes a terminal state before its subprocess finishes shutting
        // down. Abort also drains that remaining task without changing terminal
        // records, so the native close guard cannot veto teardown in that gap.
        if (session.state !== 'idle') await window.praxis.ai.abort(session.issueKey);
      }));
    });
  }
}

/** Projects hide their board in the sidebar until the header toggle reveals it; reveals it (once) for the given scope. */
export async function showProjectBoard(scope: Pick<Page, 'getByTestId'> | { getByTestId: Page['getByTestId'] }): Promise<void> {
  const toggle = scope.getByTestId('project-boards-toggle').first();
  await toggle.waitFor({ state: 'visible' });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
}
