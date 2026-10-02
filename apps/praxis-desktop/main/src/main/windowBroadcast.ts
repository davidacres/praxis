import { BrowserWindow } from 'electron';

/**
 * Safely dispatches an IPC message to a BrowserWindow only if the window,
 * its webContents, and its main render frame are all intact and alive.
 * This prevents the "Render frame was disposed before WebFrameMain could be accessed"
 * error when broadcasting events while a window is closing, navigating, or refreshing.
 */
export function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]): boolean {
  try {
    if (win.isDestroyed()) {
      return false;
    }
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || (typeof wc.isCrashed === 'function' && wc.isCrashed())) {
      return false;
    }
    const frame = wc.mainFrame;
    if (!frame || frame.isDestroyed()) {
      return false;
    }
    wc.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Broadcasts an IPC message to a collection of browser windows, skipping any
 * windows whose render frames are disposed or closing.
 */
export function broadcastToWindows(windows: readonly BrowserWindow[], channel: string, ...args: unknown[]): void {
  for (const win of windows) {
    safeSend(win, channel, ...args);
  }
}

/**
 * Broadcasts an IPC message to all live browser windows whose render frames
 * are active.
 */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  const windows = typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : [];
  broadcastToWindows(windows, channel, ...args);
}
