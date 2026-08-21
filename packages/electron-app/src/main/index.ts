import * as path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import { registerBoardIpc } from './boardIpc';
import { registerIssueIpc } from './issueIpc';
import { registerConnectionIpc } from './connectionIpc';
import { attachWindowStateEvents, registerWindowIpc } from './windowIpc';

const isMac = process.platform === 'darwin';

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

void app.whenReady().then(() => {
  // No File/Edit/View/Window/Help menubar — the custom title bar is the only chrome.
  Menu.setApplicationMenu(null);

  registerBoardIpc();
  registerIssueIpc();
  registerConnectionIpc();
  registerWindowIpc();
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
