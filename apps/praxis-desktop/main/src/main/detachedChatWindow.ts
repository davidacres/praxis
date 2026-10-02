import * as path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import { attachRendererNavigationGuard, rendererDir } from './rendererNavigationGuard';
import { broadcastToAllWindows } from './windowBroadcast';

/**
 * The floating chat window (FX-BE-143): a standalone conversation popped out
 * into its own always-on-top, resizable, native-framed `BrowserWindow`. This
 * module is the single authority for which conversations are currently
 * detached — the main window's renderer asks it (`detachedChat:list` /
 * `detachedChat:changed`) so it never renders the same conversation's live
 * console twice at once.
 *
 * Deliberately in-memory only, not persisted: a relaunch after the app was
 * quit (or killed) while a conversation was floating starts with an empty
 * registry, so that conversation simply shows up in the main window's
 * Conversations list again — never stuck in a window that no longer exists.
 */
const detachedWindows = new Map<string, BrowserWindow>();

/** Last floating window's bounds, remembered across pop-outs within this run. */
let lastBounds: { x: number; y: number; width: number; height: number } | undefined;

function broadcastChanged(): void {
  const keys = [...detachedWindows.keys()];
  broadcastToAllWindows('detachedChat:changed', keys);
}

export function detachedChatKeys(): string[] {
  return [...detachedWindows.keys()];
}

export function isDetachedChat(issueKey: string): boolean {
  return detachedWindows.has(issueKey);
}

export function openDetachedChat(issueKey: string, devServerUrl: string | undefined): void {
  const existing = detachedWindows.get(issueKey);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: lastBounds?.width ?? 420,
    height: lastBounds?.height ?? 640,
    ...(lastBounds ? { x: lastBounds.x, y: lastBounds.y } : {}),
    minWidth: 320,
    minHeight: 360,
    // Native framing is deliberate (FX-BE-143): it gives this, the app's first
    // window beyond the single frameless main one, a platform-consistent close
    // control for free — the renderer only needs to supply the pop-in action.
    frame: true,
    alwaysOnTop: true,
    title: 'Conversation — Praxis',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  attachRendererNavigationGuard(win, devServerUrl);
  detachedWindows.set(issueKey, win);
  broadcastChanged();

  win.on('close', () => {
    lastBounds = win.getBounds();
  });
  win.on('closed', () => {
    detachedWindows.delete(issueKey);
    broadcastChanged();
  });

  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set('detachedSession', issueKey);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(rendererDir, 'index.html'), { query: { detachedSession: issueKey } });
  }
}

/** Pop-in: closes the floating window and returns the conversation to the main window. */
export function closeDetachedChat(issueKey: string): void {
  const win = detachedWindows.get(issueKey);
  if (win && !win.isDestroyed()) win.close();
}

/** Called when the main window closes or the app quits — never leaves an orphaned floating window. */
export function closeAllDetachedChats(): void {
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
}

export function registerDetachedChatIpc(devServerUrl: string | undefined): void {
  ipcMain.handle('detachedChat:open', async (_event, issueKey: string) => {
    openDetachedChat(issueKey, devServerUrl);
  });
  ipcMain.handle('detachedChat:close', async (_event, issueKey: string) => {
    closeDetachedChat(issueKey);
  });
  ipcMain.handle('detachedChat:list', async () => detachedChatKeys());
}
