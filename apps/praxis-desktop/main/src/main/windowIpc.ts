import * as os from 'node:os';
import { BrowserWindow, ipcMain } from 'electron';
import { getSettingsBackend } from './settingsBackendInstance';
import { safeSend } from './windowBroadcast';

const confirmedWindows = new WeakSet<BrowserWindow>();
const APP_ZOOM_MIN = 0.7;
const APP_ZOOM_MAX = 1.5;
const APP_ZOOM_STEP = 0.1;

export function clampZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, Math.round(value * 10) / 10));
}

export function getInitialZoomFactor(): number {
  try {
    const factor = getSettingsBackend().read().appearance.zoomFactor;
    return clampZoomFactor(factor);
  } catch {
    return 1;
  }
}

function publishZoomFactor(win: BrowserWindow, factor: number): number {
  const next = clampZoomFactor(factor);
  if (win.isDestroyed()) return next;
  try {
    win.webContents.setZoomFactor(next);
  } catch {
    // webContents may be destroyed/closing
  }
  safeSend(win, 'window:zoomChanged', next);
  try {
    const backend = getSettingsBackend();
    const current = backend.read().appearance.zoomFactor;
    if (current !== next) {
      void backend.write({ appearance: { zoomFactor: next } }).catch(err => {
        console.error('Failed to persist zoom factor:', err);
      });
    }
  } catch {
    // Backend may not be initialised in some test contexts
  }
  return next;
}

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

  ipcMain.handle('window:confirmClose', async (event: Electron.IpcMainInvokeEvent) => {
    const win = senderWindow(event);
    if (!win || win.isDestroyed()) return;
    confirmedWindows.add(win);
    win.close();
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

  ipcMain.handle('window:getZoomFactor', async (event: Electron.IpcMainInvokeEvent) => {
    const win = senderWindow(event);
    if (!win || win.isDestroyed()) return getInitialZoomFactor();
    const current = win.webContents.getZoomFactor();
    const initial = getInitialZoomFactor();
    if (Math.abs(current - 1) < 0.01 && Math.abs(initial - 1) >= 0.01) {
      win.webContents.setZoomFactor(initial);
      return initial;
    }
    return current;
  });

  ipcMain.handle('window:setZoomFactor', async (event: Electron.IpcMainInvokeEvent, factor: number) => {
    const win = senderWindow(event);
    return win ? publishZoomFactor(win, factor) : getInitialZoomFactor();
  });
}

/**
 * Electron does not expose a native application menu in Praxis, so own the
 * familiar browser/VS Code zoom shortcuts at the BrowserWindow boundary.
 * This ensures they work from the chat, either sidebar, inspector, composer,
 * and dialogs alike instead of depending on whichever renderer element has
 * focus.
 */
export function attachWindowZoomShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.control && !input.meta)) return;
    if (input.key === '0') {
      event.preventDefault();
      publishZoomFactor(win, 1);
      return;
    }
    if (input.key === '+' || input.key === '=' || input.key === 'Add') {
      event.preventDefault();
      publishZoomFactor(win, win.webContents.getZoomFactor() + APP_ZOOM_STEP);
      return;
    }
    if (input.key === '-' || input.key === '_' || input.key === 'Subtract') {
      event.preventDefault();
      publishZoomFactor(win, win.webContents.getZoomFactor() - APP_ZOOM_STEP);
    }
  });
}

/**
 * Intercepts native and renderer-requested closes while an app-owned AI task
 * is live. The renderer owns the themed confirmation surface; the main
 * process owns the close veto so macOS traffic lights and Windows caption
 * buttons behave identically.
 */
export function attachWindowCloseGuard(win: BrowserWindow, getRunningSessionCount: () => number): void {
  win.on('close', event => {
    if (confirmedWindows.delete(win)) return;
    const runningSessionCount = getRunningSessionCount();
    if (runningSessionCount <= 0) return;
    event.preventDefault();
    safeSend(win, 'window:closeRequested', { runningSessionCount });
  });
}

/** Pushes maximize state to the renderer so the caption button can swap its glyph. */
export function attachWindowStateEvents(win: BrowserWindow): void {
  const send = (maximized: boolean) => {
    safeSend(win, 'window:maximizeChanged', maximized);
  };
  win.on('maximize', () => send(true));
  win.on('unmaximize', () => send(false));
}
