import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage } from 'electron';
import { registerBoardIpc } from './boardIpc';
import { registerIssueIpc } from './issueIpc';
import { registerConnectionIpc } from './connectionIpc';
import { registerProjectImportIpc } from './projectImportIpc';
import { registerFolderIpc } from './folderIpc';
import { registerDialogIpc } from './dialogIpc';
import { registerSettingsIpc } from './settingsIpc';
import { registerLogIpc } from './logIpc';
import { getLogBus } from './logBusInstance';
import { registerAutoUpdate } from './autoUpdate';
import { registerShellIpc } from './shellIpc';
import { registerBrowserIpc } from './browserIpc';
import { registerBoardPrefsIpc } from './boardPrefsIpc';
import { registerAiIpc } from './aiIpc';
import { registerAiUsageIpc, startAiUsageTracking } from './aiUsageIpc';
import { registerAiWorkflowIpc } from './aiWorkflowIpc';
import { registerTaskDesignerIpc } from './taskDesignerIpc';
import { registerWorkflowIpc, recoverWorkflowRunsOnStartup } from './workflowIpc';
import { registerGitIpc } from './gitIpc';
import { attachWindowCloseGuard, attachWindowStateEvents, attachWindowZoomShortcuts, platformSupportsVibrancy, registerWindowIpc, setWindowVibrancy } from './windowIpc';
import { getSettingsBackend, initSettingsBackend } from './settingsBackendInstance';
import { setMcpOAuthProviderSource } from '@praxis/core';
import { getDesktopMcpOAuthManager, OAUTH_SCHEME } from './mcpOAuthManager';
import { disposeAllServices } from './serviceRegistry';
import { getAcpAgentHost, getAllActiveTaskIssueKeys } from './aiInstance';
import { registerProjectIpc } from './projectIpc';
import { registerRunProfileIpc } from './runProfileIpc';
import { registerRunControlIpc } from './runControlIpc';
import { registerDeploymentControlIpc } from './deploymentControlIpc';
import { registerDeploymentProfileIpc } from './deploymentProfileIpc';
import { registerDeploymentArtifactIpc } from './deploymentArtifactIpc';
import { registerWorkspaceIpc } from './workspaceIpc';
import { registerTerminalIpc } from './terminalIpc';
import { getTerminalManager } from './terminalManager';
import { registerAgentRuntimeIpc } from './agentRuntimeIpc';
import { registerGadgetIpc } from './gadgetIpc';
import { registerTicketReviewIpc } from './ticketReviewIpc';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { registerMarketplaceIpc } from './marketplaceIpc';
import { reconcileInstalledOnLaunch } from './marketplaceInstance';
import { initMobileHost } from './mobileListenerInstance';

const isMac = process.platform === 'darwin';

/**
 * Renamed from Electron's unpackaged default (the npm package name,
 * "@praxis/desktop-main") to the "Praxis" product name — this is what
 * shows in the macOS menu bar, Force Quit, Alt-Tab, etc. Capture the old
 * default before renaming so `migrateLegacyUserData` (below) can find it.
 */
const legacyAppName = app.getName();
app.setName('Praxis');

/**
 * Packaged builds get their icon baked into the .app/.exe by electron-builder
 * from `build/icon.png` at build time, so this only matters for unpackaged
 * dev runs (`npm start` / `electron .`), which otherwise show Electron's
 * default icon.
 */
function getDevAppIcon() {
  if (app.isPackaged) return undefined;
  return nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
}

/**
 * One-time migration for the Praxis rename: `app.getPath('userData')` is
 * derived from the app name, so renaming it orphans everything already on
 * disk under the old name — projects.json, board-preferences.json,
 * task-designer.json, ai-sessions.json, ai-analysis.json, and
 * userWorkspace.json. Copy those forward before anything reads or writes
 * userData. Secrets are deliberately excluded below because safeStorage
 * ciphertext is scoped to the old app identity on macOS and cannot be
 * decrypted after the rename.
 *
 * Only copies the flat `*.json` store files, not Electron's own internal
 * subdirectories (Cache, session partition, Local State, singleton-lock
 * files) — those are disposable, and copying a directory onto one Electron
 * already created for the new name throws EEXIST (`fs.cpSync` won't merge
 * into an existing destination directory).
 *
 * Can't gate on "does the new userData directory exist" — Electron itself
 * creates it (SingletonLock, session partition files) as a side effect of
 * `app.requestSingleInstanceLock()`, which runs at module load, well before
 * this does. So this uses an explicit marker file instead.
 *
 * Does not touch the shared settings.json (see `resolveSharedSettingsPath` in
 * `@praxis/core`) — that lives at a fixed, name-independent path
 * shared with the VS Code extension and is unaffected by this rename.
 *
 * Users whose credentials were stored under the old app identity must
 * reconnect or re-enter them once after upgrading. The secrets adapter also
 * fails closed if it encounters an unreadable legacy blob.
 */
function migrateLegacyUserData(): void {
  if (legacyAppName === app.getName()) return;
  // Playwright and other callers may intentionally supply an isolated profile.
  // Never populate an explicitly selected profile with the developer's old
  // application data.
  if (process.argv.some(argument => argument.startsWith('--user-data-dir='))) return;
  const newPath = app.getPath('userData');
  const marker = path.join(newPath, '.praxis-rename-migration-checked');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(newPath, { recursive: true });
  const legacyPath = path.join(app.getPath('appData'), legacyAppName);
  try {
    if (fs.existsSync(legacyPath)) {
      const jsonFiles = fs.readdirSync(legacyPath)
        .filter(name => name.endsWith('.json'))
        .filter(name => name !== 'secrets.json');
      for (const name of jsonFiles) {
        fs.copyFileSync(path.join(legacyPath, name), path.join(newPath, name));
      }
      if (jsonFiles.length > 0) {
        console.log(
          `[startup] migrated ${jsonFiles.length} userData file(s) from "${legacyAppName}" to "${app.getName()}": ${jsonFiles.join(', ')}`
        );
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (error) {
    console.warn('[startup] userData migration failed:', error);
  }
}

/**
 * Single instance: OAuth callbacks arrive as `praxis://` URLs, which
 * the OS delivers by launching a second process — forward its argv URL to the
 * first instance's OAuth manager instead of opening another window. The lock
 * is per userData dir, so parallel e2e instances don't collide.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(arg => arg.startsWith(`${OAUTH_SCHEME}:`));
    if (url) {
      getDesktopMcpOAuthManager().handleProtocolUrl(url);
    }
  });
}

// macOS delivers protocol URLs via open-url instead of a second process.
app.on('open-url', (event, url) => {
  event.preventDefault();
  getDesktopMcpOAuthManager().handleProtocolUrl(url);
});

/**
 * Reads the persisted Surface dial that opts into native OS window translucency.
 * A transparent BrowserWindow is a construction-only option, so this is resolved
 * here rather than after the renderer boots. Defensive: any settings failure just
 * means an opaque window (the CSS faux-depth path still runs).
 */
function wantsWindowVibrancyAtLaunch(): boolean {
  if (!platformSupportsVibrancy()) {
    return false;
  }
  try {
    return getSettingsBackend().read().appearance.surface.windowVibrancy === true;
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const vibrancy = wantsWindowVibrancyAtLaunch();
  const win = new BrowserWindow({
    // Landscape-first default: 16:9 gives the board and project panes room to
    // sit side by side on the first launch.
    width: 1664,
    height: 936,
    minWidth: 720,
    minHeight: 480,
    icon: getDevAppIcon(),
    // The renderer draws the whole chrome, so paint the shell colour behind it to avoid a
    // white flash between window creation and first paint. A vibrancy window must instead
    // start transparent so the desktop shows through the frosted panels.
    backgroundColor: vibrancy ? '#00000000' : '#1c1c1c',
    show: false,
    ...(vibrancy && isMac ? { vibrancy: 'under-window' as const, transparent: true } : {}),
    ...(vibrancy && !isMac && process.platform === 'win32'
      ? { backgroundMaterial: 'acrylic' as const }
      : {}),
    // Frameless everywhere. On macOS `titleBarStyle: 'hidden'` keeps the traffic lights,
    // inset to line up with the custom title bar's 40px height.
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 13 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  attachWindowStateEvents(win);
  attachWindowZoomShortcuts(win);
  attachWindowCloseGuard(win, () => getAllActiveTaskIssueKeys().length);
  if (vibrancy) {
    setWindowVibrancy(win, 'glass');
  }
  win.once('ready-to-show', () => win.show());

  const devServerUrl = process.env.PRAXIS_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

// The settings backend is initialised (and one-time migrated) before any IPC
// handler is registered so the very first `settings:get` resolves against the
// up-to-date file.
void app.whenReady().then(async () => {
  migrateLegacyUserData();

  if (isMac) {
    const devIcon = getDevAppIcon();
    if (devIcon) app.dock?.setIcon(devIcon);
  }

  await initSettingsBackend();

  // Desktop OAuth for HTTP MCP servers (e.g. Atlassian Cloud): register the
  // praxis:// protocol so the OAuth redirect lands back in this app —
  // a stable scheme URL is what org admins allowlist (a localhost port reads
  // as an untrusted app to restricted Atlassian orgs). Dev/unpackaged runs
  // need the explicit executable + app path in the registry entry. Falls back
  // to the loopback listener when registration fails. Registered after
  // whenReady because token storage uses safeStorage.
  const schemeRegistered =
    process.defaultApp && process.argv.length >= 2
      ? app.setAsDefaultProtocolClient(OAUTH_SCHEME, process.execPath, [
          path.resolve(process.argv[1])
        ])
      : app.setAsDefaultProtocolClient(OAUTH_SCHEME);
  getDesktopMcpOAuthManager().setSchemeRedirectEnabled(schemeRegistered);
  if (!schemeRegistered) {
    console.warn('[oauth] praxis:// registration failed; falling back to loopback redirect');
  }

  setMcpOAuthProviderSource(() => getDesktopMcpOAuthManager());
  void getDesktopMcpOAuthManager()
    .init()
    .catch(error => console.error('[oauth] loopback listener failed to start:', error));

  // No File/Edit/View/Window/Help menubar — the custom title bar is the only chrome.
  Menu.setApplicationMenu(null);

  registerBoardIpc();
  registerIssueIpc();
  registerConnectionIpc();
  registerProjectImportIpc();
  registerFolderIpc();
  registerDialogIpc();
  registerWindowIpc();
  registerSettingsIpc();
  registerLogIpc();
  registerShellIpc();
  registerBrowserIpc();
  registerBoardPrefsIpc();
  registerAiIpc();
  registerTicketReviewIpc();
  registerAiUsageIpc();
  startAiUsageTracking();
  registerAiWorkflowIpc();
  registerTaskDesignerIpc();
  registerWorkflowIpc();
  void recoverWorkflowRunsOnStartup().catch(error => console.error('Workflow run recovery failed:', error));
  registerProjectIpc();
  registerRunProfileIpc();
  registerRunControlIpc();
  registerDeploymentControlIpc();
  registerDeploymentProfileIpc();
  registerDeploymentArtifactIpc();
  registerWorkspaceIpc();
  registerTerminalIpc();
  registerAgentRuntimeIpc();
  registerGadgetIpc();
  registerMarketplaceIpc();
  registerGitIpc();
  // Mobile companion: compose the host, serve the IPC bridge, and drive the
  // Noise LAN listener from the persisted access policy (default `off` — nothing
  // binds).
  void initMobileHost().catch(error =>
    getLogBus().appendLine(`[mobile] init failed: ${error instanceof Error ? error.message : String(error)}`)
  );
  ipcMain.handle('app:getVersion', () => app.getVersion());
  registerAutoUpdate(() => BrowserWindow.getAllWindows(), getLogBus());
  // Mirror trusted agent add-ons onto disk before the first discovery pass, and
  // (if configured) log any available add-on updates.
  void reconcileInstalledOnLaunch()
    .catch(error => getLogBus().appendLine(`[marketplace] launch reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      void getAgentRuntimeManager().refresh().then(async snapshot => {
        getLogBus().appendLine(`[agent-runtime] discovered ${snapshot.profiles?.length ?? 0} profiles, ${(snapshot.runtimeHosts ?? snapshot.agents).length} runtime hosts, and ${snapshot.skills.length} skills`);
        for (const agent of (snapshot.runtimeHosts ?? snapshot.agents).filter(candidate => candidate.trusted && candidate.manifest.activation === 'startup')) {
          try {
            await getAgentRuntimeManager().start(agent.manifest.id);
            getLogBus().appendLine(`[agent-runtime] started ${agent.manifest.id}`);
          } catch (error) {
            getLogBus().appendLine(`[agent-runtime] failed to start ${agent.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }).catch(error => {
        getLogBus().appendLine(`[agent-runtime] discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  // Seed the Output panel with a launch marker — also gives e2e a
  // deterministic first line to assert against.
  getLogBus().appendLine(`[app] Praxis ${app.getVersion()} started`);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

// Close any folder/user-workspace file watchers before the process
// exits — an open chokidar watcher otherwise keeps the event loop alive and
// hangs a graceful quit (see disposeAllServices' doc comment).
app.on('before-quit', () => {
  disposeAllServices();
  // An ACP-hosted session's subprocess (Claude Code, Codex, or GitHub
  // Copilot via `copilot --acp`) is a child of this process — leaving one
  // running past quit is the exact same "process won't exit" hang as an
  // unclosed chokidar watcher (see disposeAllServices' doc comment).
  getAcpAgentHost().dispose();
  getTerminalManager().dispose();
  void getAgentRuntimeManager().dispose();
});
