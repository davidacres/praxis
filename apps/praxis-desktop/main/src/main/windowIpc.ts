import * as os from 'node:os';
import { BrowserWindow, ipcMain } from 'electron';

/**
 * The app runs frameless, so the renderer draws its own caption buttons and drives the native
 * window through these channels. Each handler resolves the window from the sender rather than a
 * module-level singleton so it stays correct if a second window is ever opened.
 */
function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/**
 * Whether the running OS can composite a translucent window behind the app:
 * macOS always, Windows 11 build 22000+ (acrylic / mica), never Linux. Drives
 * both the launch-time window options and the Surface panel's Window-blur toggle.
 */
export function platformSupportsVibrancy(): boolean {
  if (process.platform === 'darwin') {
    return true;
  }
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    return build >= 22000;
  }
  return false;
}

/**
 * Turns native window translucency on or off for a live window. macOS uses the
 * "under-window" vibrancy material; Windows 11 uses acrylic. A no-op elsewhere.
 * Returns whether anything was actually applied so the renderer knows whether
 * to also drop its own ground to transparent.
 */
export function setWindowVibrancy(win: BrowserWindow, mode: 'off' | 'glass'): boolean {
  if (win.isDestroyed() || !platformSupportsVibrancy()) {
    return false;
  }
  if (process.platform === 'darwin') {
    win.setVibrancy(mode === 'glass' ? 'under-window' : null);
    return true;
  }
  if (process.platform === 'win32') {
    win.setBackgroundMaterial(mode === 'glass' ? 'acrylic' : 'none');
    return true;
  }
  return false;
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:reload', async (event: Electron.IpcMainInvokeEvent) => {
    senderWindow(event)?.webContents.reload();
  });

  ipcMain.handle('window:minimize', async (event: Electron.IpcMainInvokeEvent) => {
    senderWindow(event)?.minimize();
  });

  ipcMain.handle('window:toggleMaximize', async (event: Electron.IpcMainInvokeEvent) => {
    const win = senderWindow(event);
    if (!win) {
      return false;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle('window:close', async (event: Electron.IpcMainInvokeEvent) => {
    senderWindow(event)?.close();
  });

  ipcMain.handle('window:isMaximized', async (event: Electron.IpcMainInvokeEvent) => {
    return senderWindow(event)?.isMaximized() ?? false;
  });

  ipcMain.handle('window:supportsVibrancy', async () => platformSupportsVibrancy());

  ipcMain.handle('window:setSurfaceVibrancy', async (event: Electron.IpcMainInvokeEvent, mode: 'off' | 'glass') => {
    const win = senderWindow(event);
    const applied = win ? setWindowVibrancy(win, mode === 'glass' ? 'glass' : 'off') && mode === 'glass' : false;
    return { applied };
  });
}

/** Pushes maximize state to the renderer so the caption button can swap its glyph. */
export function attachWindowStateEvents(win: BrowserWindow): void {
  const send = (maximized: boolean) => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximizeChanged', maximized);
    }
  };
  win.on('maximize', () => send(true));
  win.on('unmaximize', () => send(false));
}
