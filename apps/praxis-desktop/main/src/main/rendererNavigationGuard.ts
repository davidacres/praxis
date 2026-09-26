import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserWindow, shell } from 'electron';

/** Same compiled output directory (`out/main/`) for every file in this package. */
export const rendererDir = path.join(__dirname, '../../renderer');

/**
 * Is `url` a renderer this app itself loaded — the dev server origin, or a
 * file:// path under the packaged renderer directory? Anything else (an
 * in-app link, a compromised-renderer redirect, a spoofed window.open) is not
 * something an app-owned window should ever navigate to.
 */
export function isOwnRendererUrl(url: string, devServerUrl: string | undefined, dir: string = rendererDir): boolean {
  try {
    const target = new URL(url);
    if (devServerUrl) return target.origin === new URL(devServerUrl).origin;
    if (target.protocol !== 'file:') return false;
    const relative = path.relative(dir, fileURLToPath(target));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/** Only these schemes are worth handing to the OS — anything else is silently dropped. */
export function openInOsBrowser(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/**
 * Guards a window that only ever needs to show this app's own renderer
 * (the main window, and the floating chat window it can pop a conversation
 * into — see `detachedChatWindow.ts`): any navigation or new-window request
 * away from that renderer is blocked, and http(s)/mailto targets are handed
 * to the OS browser instead.
 */
export function attachRendererNavigationGuard(win: BrowserWindow, devServerUrl: string | undefined): void {
  const guard = (event: Electron.Event, url: string) => {
    if (isOwnRendererUrl(url, devServerUrl)) return;
    event.preventDefault();
    openInOsBrowser(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInOsBrowser(url);
    return { action: 'deny' };
  });
}
