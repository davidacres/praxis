import { BrowserWindow, ipcMain } from 'electron';

/**
 * The app runs frameless, so the renderer draws its own caption buttons and drives the native
 * window through these channels. Each handler resolves the window from the sender rather than a
 * module-level singleton so it stays correct if a second window is ever opened.
 */
function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerWindowIpc(): void {
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
