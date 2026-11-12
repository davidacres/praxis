import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

/**
 * The e2e harness runs the real renderer (`tauri.html`) in Chromium against the
 * real desktop backend: the `praxis-desktop` binary in `--e2e-server` mode, which
 * composes exactly what the GUI composes. WKWebView offers Playwright no way to
 * attach, so only the webview is substituted; `window.praxis` is the production
 * bridge and every channel is answered by the Rust host.
 */
// macOS reports its temp dir through a symlink (/var -> /private/var). The backend
// canonicalises every path it stores, so specs comparing a path they created under
// os.tmpdir() with one the app returned need the canonical form from the start.
try { process.env.TMPDIR = fs.realpathSync(os.tmpdir()); } catch { /* keep the default */ }
const REPO_ROOT =path.resolve(__dirname, '../../..');
const BACKEND_BINARY = process.env.PRAXIS_TAURI_BIN
  ?? path.join(REPO_ROOT, 'target', 'debug', process.platform === 'win32' ? 'praxis-desktop.exe' : 'praxis-desktop');

/** Stand-in for the Electron application object the specs were written against. */
export interface BackendHandle {
  process(): ChildProcess;
  close(): Promise<void>;
  context(): BrowserContext;
  windows(): Page[];
  /** Electron main-process evaluation has no equivalent: the backend is a separate Rust process. */
  evaluate(...args: unknown[]): Promise<never>;
  waitForEvent(event: string): Promise<never>;
}

/** What a channel override can reach besides its own arguments. */
export interface ChannelContext {
  /** Calls the real backend (the Rust host), bypassing every override - the "original" handler. */
  call(channel: string, ...args: unknown[]): Promise<any>;
  /**
   * Like `call`, but also reaches host channels outside the renderer contract (what the
   * native shell itself invokes after a dialog, e.g. `workspaces:writeFile`).
   */
  host(channel: string, ...args: unknown[]): Promise<any>;
}

/**
 * Answers a renderer IPC call in the test process. Replaces the Electron-era
 * `ipcMain.removeHandler(ch); ipcMain.handle(ch, ...)` stubs and `dialog.show*Dialog`
 * mocks. Runs in Node, so it can close over fixtures and record calls in ordinary
 * variables instead of `globalThis` in the (retired) main process. Throw to reject
 * the renderer's promise; a thrown `{ code, message }` object is passed through.
 */
export type ChannelHandler = (args: any[], context: ChannelContext) => unknown | Promise<unknown>;

export interface TestApp {
  electronApp: BackendHandle;
  window: Page;
  userDataDir: string;
  /** Per-test settings file the app reads/writes instead of the real shared one. */
  settingsPath: string;
  /**
   * Make every page's calls to `channel` answer from `handler` instead of the backend.
   * Survives reloads and applies to every page of the context; a later call replaces
   * an earlier handler for the same channel.
   */
  overrideChannel(channel: string, handler: ChannelHandler): Promise<void>;
  /** Stop overriding `channel`; calls reach the backend again. */
  restoreChannel(channel: string): Promise<void>;
  /** Calls the real backend directly (what the renderer would get with no override). */
  callBackend(channel: string, ...args: unknown[]): Promise<any>;
  /**
   * Delivers a host event to the renderer exactly as the backend's event stream would
   * (`webContents.send(channel, payload)` in the Electron main process). Goes to every
   * page of the context unless `page` is given.
   */
  emitEvent(channel: string, payload?: unknown, page?: Page): Promise<void>;
  /**
   * Opens another window onto the same backend: a new page of the same browser context
   * (so it shares storage, the channel overrides and the event stream, like a second
   * `BrowserWindow` on the Electron main process). Defaults to the main window's URL.
   */
  openWindow(url?: string): Promise<Page>;
  /** Every open window (page), main window first. */
  windows(): Page[];
  /** Calls a host channel outside the renderer contract (what the native shell itself invokes). */
  callHost(channel: string, ...args: unknown[]): Promise<any>;
  /**
   * What the shell does when the user closes or quits: asks the renderer to confirm
   * (`window:closeRequested`, with the running-session count and the next armed schedule,
   * exactly as the Electron main process derived them). Resolves with a promise that settles
   * when the renderer confirms (`window:confirmClose`) - the point at which the app would exit.
   */
  requestClose(): Promise<Promise<void>>;
}

/**
 * Runs in the page before any script. Provides the two Tauri entry points the
 * renderer's bridge uses (`invoke('praxis_rpc')` and `listen('praxis:event')`),
 * forwarding to the backend over loopback. Mirrors `@tauri-apps/api/mocks`
 * for the callback/listener bookkeeping that `listen` relies on.
 */
function tauriShim({ port, token }: { port: number; token: string }): void {
  const base = `http://127.0.0.1:${port}`;
  const w = window as any;
  w.__TAURI_INTERNALS__ = w.__TAURI_INTERNALS__ ?? {};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = w.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  const register = (callback: (data: unknown) => void, once = false): number => {
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    callbacks.set(id, data => { if (once) callbacks.delete(id); callback?.(data); });
    return id;
  };
  const dispatch = (envelope: unknown) => {
    for (const id of [...(listeners.get('praxis:event') ?? [])]) {
      callbacks.get(id)?.({ event: 'praxis:event', id, payload: envelope });
    }
  };
  // Test control: deliver a synthetic host event, as `webContents.send` did.
  w.__praxisE2eEmit = dispatch;
  let source: EventSource | undefined;
  const ensureEvents = () => {
    if (source) return;
    source = new EventSource(`${base}/events?token=${token}`);
    source.onmessage = message => {
      dispatch(JSON.parse(message.data));
    };
  };
  w.__TAURI_INTERNALS__.transformCallback = register;
  w.__TAURI_INTERNALS__.unregisterCallback = (id: number) => callbacks.delete(id);
  w.__TAURI_INTERNALS__.runCallback = (id: number, data: unknown) => callbacks.get(id)?.(data);
  w.__TAURI_INTERNALS__.callbacks = callbacks;
  w.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = (event: string, id: number) => {
    listeners.get(event)?.delete(id);
    callbacks.delete(id);
  };
  w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
    if (command === 'plugin:event|listen') {
      if (!listeners.has(args.event)) listeners.set(args.event, new Set());
      listeners.get(args.event)!.add(args.handler);
      if (args.event === 'praxis:event') ensureEvents();
      return args.handler;
    }
    if (command === 'plugin:event|unlisten') return undefined;
    if (command !== 'praxis_rpc') throw { code: 'UNSUPPORTED', message: `No e2e handler for Tauri command ${command}` };
    // Per-test channel overrides (TestApp.overrideChannel) answer from the test process.
    if (w.__praxisOverrideNames?.has(args.channel) && w.__praxisE2eOverride) {
      const answer = await w.__praxisE2eOverride(args.channel, args.args ?? []);
      if (!answer.ok) throw answer.error;
      return answer.result;
    }
    const response = await fetch(`${base}/rpc?token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ channel: args.channel, args: args.args })
    });
    const body = await response.json();
    if (!body.ok) throw body.error ?? { code: 'DESKTOP_ERROR', message: 'Unknown backend error' };
    // The desktop shell reloads its webview for this channel; the e2e server cannot.
    if (args.channel === 'window:reload') setTimeout(() => window.location.reload(), 0);
    return body.result;
  };
}

/**
 * Playwright already traces every context a test launches (`trace: 'retain-on-failure'`), so a spec
 * that starts its own trace (the Electron-era `electronApp.context().tracing.start`) would hit
 * "Tracing has been already started". Starting is then a no-op, and stopping it writes
 * the requested file from the chunk recorded so far and reopens a chunk, so the harness trace
 * keeps recording to the end of the test.
 */
function tracingTolerantContext(context: BrowserContext): BrowserContext {
  const tracing = new Proxy(context.tracing, {
    get(target, prop) {
      if (prop === 'start') return async () => undefined;
      if (prop === 'stop') {
        return async (options?: { path?: string }) => {
          if (!options?.path) return;
          await target.stopChunk({ path: options.path });
          await target.startChunk();
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'tracing') return tracing;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function backendHandle(backend: ChildProcess, context: BrowserContext): BackendHandle {
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} drove the retired Electron main process and has no equivalent: the backend is a separate Rust process. Use TestApp.overrideChannel (stub/record a channel or dialog), emitEvent (push a host event), openWindow, callBackend/callHost, page.setViewportSize, the filesystem, or notReproducible() for a native-only step.`);
  };
  return {
    process: () => backend,
    context: () => tracingTolerantContext(context),
    windows: () => context.pages(),
    evaluate: unsupported('electronApp.evaluate'),
    waitForEvent: unsupported('electronApp.waitForEvent'),
    async close() {
      await context.close().catch(() => undefined);
      if (backend.exitCode !== null || backend.signalCode !== null) return;
      const exited = new Promise<void>(resolve => backend.once('exit', () => resolve()));
      backend.stdin?.end();
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    }
  };
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
    // A startup error exits the test app instead of opening a modal error box on the desktop.
    PRAXIS_E2E: '1',
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

  const token = randomBytes(16).toString('hex');
  env.PRAXIS_E2E_TOKEN = token;
  const backend = spawn(BACKEND_BINARY, [
    '--e2e-server',
    `--user-data-dir=${userDataDir}`,
    `--settings-path=${settingsPath}`,
    ...(options?.demoMode === false ? [] : ['--demo'])
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let backendStderr = '';
  backend.stderr.on('data', chunk => {
    backendStderr += String(chunk);
    // Debugging aid: PRAXIS_E2E_BACKEND_LOG=<file> keeps the backend's stderr (with
    // PRAXIS_E2E_LOG_RPC=1 that is one line per RPC call).
    if (process.env.PRAXIS_E2E_BACKEND_LOG) fs.appendFileSync(process.env.PRAXIS_E2E_BACKEND_LOG, String(chunk));
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`Backend did not report a port in 20s. stderr:\n${backendStderr}`)), 20000);
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited (${code}) before it was ready. stderr:\n${backendStderr}`)); });
    backend.stdout.on('data', chunk => {
      buffered += String(chunk);
      const line = buffered.split('\n').find(candidate => candidate.includes('e2eServer'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line).e2eServer.port);
    });
  });

  const context = await chromium.launchPersistentContext(path.join(userDataDir, 'chromium-profile'), {
    viewport: { width: 1440, height: 900 },
    // The specs were written against a day-first locale ("15 Jan"); Electron took it from the OS.
    locale: 'en-GB'
  });
  await context.addInitScript(tauriShim, { port, token });
  const electronApp = backendHandle(backend, context);
  const overrides = new Map<string, ChannelHandler>();
  const callRoute = (route: 'rpc' | 'host') => async (channel: string, ...args: unknown[]): Promise<any> => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}?token=${token}`, { method: 'POST', body: JSON.stringify({ channel, args }) });
    const body = await response.json() as { ok: boolean; result?: unknown; error?: unknown };
    if (!body.ok) throw body.error ?? new Error(`Backend call ${channel} failed`);
    return body.result;
  };
  const callBackend = callRoute('rpc');
  const handlerContext: ChannelContext = { call: callBackend, host: callRoute('host') };
  await context.exposeFunction('__praxisE2eOverride', async (channel: string, args: unknown[]) => {
    const handler = overrides.get(channel);
    try {
      if (!handler) return { ok: true, result: await callBackend(channel, ...args) };
      return { ok: true, result: (await handler(args, handlerContext)) ?? null };
    } catch (error) {
      const known = error as { code?: string; message?: string };
      return { ok: false, error: known && typeof known === 'object' && known.message !== undefined
        ? { code: known.code ?? 'DESKTOP_ERROR', message: known.message } : { code: 'DESKTOP_ERROR', message: String(error) } };
    }
  });
  const syncOverrideNames = async () => {
    const names = [...overrides.keys()];
    const apply = (list: string[]) => { (window as any).__praxisOverrideNames = new Set(list); };
    await context.addInitScript(apply, names);
    await Promise.all(context.pages().map(page => page.evaluate(apply, names).catch(() => undefined)));
  };
  testAppProcesses.set(electronApp, backend);
  const window = context.pages()[0] ?? await context.newPage();
  const baseUrl = process.env.PRAXIS_E2E_RENDERER_URL ?? `http://localhost:${process.env.PRAXIS_E2E_PORT || 5173}`;
  window.on('console', message => {
    if (message.type() === 'error') console.log(`PAGE LOG [error]: ${message.text()}`);
  });
  // The Electron window had its shell (and its global shortcuts) up by the time `reload()` resolved;
  // the webview installs its host bridge asynchronously, so a key press straight after a reload
  // would reach a shell that was not listening yet. A reload resolves once the title bar is back.
  const reloadPage = window.reload.bind(window);
  window.reload = async options => {
    const response = await reloadPage(options);
    await window.locator('[data-testid="titlebar-settings"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
    return response;
  };
  await window.goto(`${baseUrl}/tauri.html`);
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

  const openWindow = async (url?: string, beforeNavigate?: (page: Page) => void): Promise<Page> => {
    const page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error') console.log(`PAGE LOG [error]: ${message.text()}`);
    });
    beforeNavigate?.(page);
    await page.goto(url ?? window.url());
    await page.waitForLoadState('domcontentloaded');
    return page;
  };
  // The native shell opens a real window for a detached chat; here that is another page.
  // The channels still run on the backend, which owns the detached-chat state and its events.
  const detached = new Map<string, Page>();
  const detachedUrl = (key: string) => {
    const url = new URL(window.url());
    url.search = `?detachedSession=${encodeURIComponent(key)}`;
    return url.toString();
  };
  const testApp: TestApp = {
    electronApp, window, userDataDir, settingsPath,
    openWindow,
    windows: () => context.pages(),
    callHost: callRoute('host'),
    async requestClose() {
      let confirm!: () => void;
      const confirmed = new Promise<void>(resolve => { confirm = resolve; });
      // Confirming is the point at which the app would exit, so the backend is stopped here.
      await testApp.overrideChannel('window:confirmClose', async () => {
        // Stopped at once (not asked to close), so nothing it was scheduled to do runs after the answer.
        testAppProcesses.get(testApp.electronApp)?.kill('SIGTERM') ?? testApp.electronApp.process().kill('SIGTERM');
        confirm();
      });
      const sessions = (await callBackend('ai:listSessions')) as Array<{ state?: string }>;
      const runningSessionCount = sessions.filter(session => ['planning', 'executing', 'awaiting_approval', 'awaiting_input'].includes(session.state ?? '')).length;
      const views = (await callBackend('scheduledRuns:list')) as Array<{ run: { name: string; scheduledStartAt: string; timezone: string; status: string; archived?: boolean } }>;
      const next = views.map(view => view.run).filter(run => !run.archived && run.status === 'scheduled')
        .sort((left, right) => Date.parse(left.scheduledStartAt) - Date.parse(right.scheduledStartAt))[0];
      await testApp.emitEvent('window:closeRequested', {
        runningSessionCount,
        ...(next ? { nextSchedule: { name: next.name, scheduledStartAt: next.scheduledStartAt, timezone: next.timezone } } : {})
      });
      // An async function adopts a returned promise, which would make `await requestClose()` wait
      // for the confirmation itself. Hand back a non-thenable so the caller can answer the dialog
      // first; `await closed` then does not wait, and the file reads that follow find the profile at rest.
      return { closed: confirmed } as unknown as Promise<void>;
    },
    async overrideChannel(channel, handler) { overrides.set(channel, handler); await syncOverrideNames(); },
    async restoreChannel(channel) { overrides.delete(channel); await syncOverrideNames(); },
    callBackend,
    async emitEvent(channel, payload, page) {
      const targets = page ? [page] : context.pages();
      await Promise.all(targets.map(target => target.evaluate(envelope => (window as any).__praxisE2eEmit(envelope), { channel, payload })));
    }
  };
  await testApp.overrideChannel('detachedChat:open', async ([key], backend) => {
    const result = await backend.call('detachedChat:open', key);
    if (!detached.get(key) || detached.get(key)!.isClosed()) {
      // Registered before the page navigates: a window closed while it is still loading must
      // still tell the backend, as the shell does.
      await openWindow(detachedUrl(key), page => {
        detached.set(key, page);
        page.once('close', () => {
          if (detached.get(key) === page) { detached.delete(key); void callBackend('detachedChat:close', key).catch(() => undefined); }
        });
      });
    }
    return result;
  });
  await testApp.overrideChannel('detachedChat:close', async ([key], backend) => {
    const result = await backend.call('detachedChat:close', key);
    const page = detached.get(key);
    detached.delete(key);
    if (page && !page.isClosed()) await page.close();
    return result;
  });
  return testApp;
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

const testAppProcesses = new WeakMap<BackendHandle, ChildProcess>();

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
        console.warn('Could not remove test profile %s; leaving it in place', userDataDir, error);
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
      // An armed schedule makes the app ask before quitting, which would veto
      // teardown. The profile is thrown away next, so removing them loses nothing.
      const schedules = await window.praxis.scheduledRuns.list().catch(() => []);
      await Promise.all(schedules.map(view => window.praxis.scheduledRuns.remove(view.run.id).catch(() => undefined)));
    });
  }
}

/** Projects hide their board in the sidebar until the header toggle reveals it; reveals it (once) for the given scope. */
export async function showProjectBoard(scope: Pick<Page, 'getByTestId'> | { getByTestId: Page['getByTestId'] }): Promise<void> {
  const toggle = scope.getByTestId('project-boards-toggle').first();
  await toggle.waitFor({ state: 'visible' });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
}

/**
 * For a step that drove a native Electron feature (main-process fault injection, native
 * window flags, OS notifications) the Chromium + Rust harness cannot reproduce. Fails the
 * test with the reason rather than faking the behaviour.
 */
export function notReproducible(reason: string): never {
  throw new Error(`Not reproducible in the Tauri e2e harness: ${reason}`);
}
