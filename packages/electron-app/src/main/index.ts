import * as path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import { registerBoardIpc } from './boardIpc';
import { registerIssueIpc } from './issueIpc';
import { registerConnectionIpc } from './connectionIpc';
import { registerUserWorkspaceIpc } from './userWorkspaceIpc';
import { registerLiveFolderIpc } from './liveFolderIpc';
import { registerDialogIpc } from './dialogIpc';
import { registerSettingsIpc } from './settingsIpc';
import { registerLogIpc } from './logIpc';
import { getLogBus } from './logBusInstance';
import { registerShellIpc } from './shellIpc';
import { registerBoardPrefsIpc } from './boardPrefsIpc';
import { registerAiIpc } from './aiIpc';
import { registerAiWorkflowIpc } from './aiWorkflowIpc';
import { registerTaskDesignerIpc } from './taskDesignerIpc';
import { attachWindowStateEvents, registerWindowIpc } from './windowIpc';
import { initSettingsBackend } from './settingsBackendInstance';
import { setMcpOAuthProviderSource } from '@ticket-manager/core';
import { getDesktopMcpOAuthManager, OAUTH_SCHEME } from './mcpOAuthManager';
import { disposeAllServices } from './serviceRegistry';
import { getAcpAgentHost } from './aiInstance';

const isMac = process.platform === 'darwin';

/**
 * Single instance: OAuth callbacks arrive as `ticketmanager://` URLs, which
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

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    // The renderer draws the whole chrome, so paint the shell colour behind it to avoid a
    // white flash between window creation and first paint.
    backgroundColor: '#1c1c1c',
    show: false,
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
  win.once('ready-to-show', () => win.show());

  const devServerUrl = process.env.TICKET_MANAGER_DEV_SERVER_URL;
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
  await initSettingsBackend();

  // Desktop OAuth for HTTP MCP servers (e.g. Atlassian Cloud): register the
  // ticketmanager:// protocol so the OAuth redirect lands back in this app —
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
    console.warn('[oauth] ticketmanager:// registration failed; falling back to loopback redirect');
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
  registerUserWorkspaceIpc();
  registerLiveFolderIpc();
  registerDialogIpc();
  registerWindowIpc();
  registerSettingsIpc();
  registerLogIpc();
  registerShellIpc();
  registerBoardPrefsIpc();
  registerAiIpc();
  registerAiWorkflowIpc();
  registerTaskDesignerIpc();
  // Seed the Output panel with a launch marker — also gives e2e a
  // deterministic first line to assert against.
  getLogBus().appendLine(`[app] Ticket Manager ${app.getVersion()} started`);
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

// Close any live-folder/user-workspace file watchers before the process
// exits — an open chokidar watcher otherwise keeps the event loop alive and
// hangs a graceful quit (see disposeAllServices' doc comment).
app.on('before-quit', () => {
  disposeAllServices();
  // An ACP-hosted session's subprocess is a child of this process — leaving
  // it running past quit is the exact same "process won't exit" hang as an
  // unclosed chokidar watcher (see disposeAllServices' doc comment).
  getAcpAgentHost().dispose();
});
