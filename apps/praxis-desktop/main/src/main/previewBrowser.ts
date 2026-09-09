import { BrowserWindow, WebContentsView, session as electronSession } from 'electron';
import { previewAccessBlockedReason } from '@praxis/core';
import { previewAccess } from './runManagerInstance';

/**
 * The Run preview surface (FX-BE-055 / TASK-146) — a `WebContentsView`, same
 * structural pattern as `aiBrowser.ts`, but a passive viewer rather than
 * something an agent drives: no click/type/snapshot, just navigate + show.
 * Every navigation, redirect, and subresource is checked against the shared
 * `previewAccess` registry via `previewAccessBlockedReason` — the same one
 * decision function TASK-145 built, applied at the three points its
 * acceptance criteria name: `will-navigate` (top-level open), `will-redirect`
 * (a redirect mid-navigation), and `webRequest.onBeforeRequest` (every
 * subresource the loaded page's own script pulls in).
 *
 * Hiding this view (`setVisible(false)` — what closing the preview tab in
 * the renderer does) never calls anything in `runManagerInstance.ts`: a
 * preview is a window onto an already-running managed service, and closing
 * that window must not stop the service it was looking at.
 */

const PARTITION = 'persist:praxis-preview';

class PreviewBrowserManager {
  private view: WebContentsView | undefined;
  private host: BrowserWindow | undefined;
  private visible = false;
  private lastBounds = { x: 0, y: 0, width: 0, height: 0 };

  private hostWindow(): BrowserWindow {
    const win =
      (this.host && !this.host.isDestroyed() ? this.host : undefined) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!win) throw new Error('No window to host the preview.');
    return win;
  }

  private ensure(win: BrowserWindow): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.host !== win) {
        this.host?.contentView.removeChildView(this.view);
        win.contentView.addChildView(this.view);
        this.host = win;
      }
      return this.view;
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    });
    this.view = view;
    this.host = win;
    win.contentView.addChildView(view);
    view.setVisible(this.visible);
    view.setBorderRadius(8);

    const ses = electronSession.fromPartition(PARTITION);
    ses.on('will-download', event => event.preventDefault());
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // Only the top-level document is covered by will-navigate/will-redirect
    // below — everything else here is a subresource the previewed page's
    // own script pulled in (script, image, xhr/fetch, iframe, …), which is
    // exactly what "unapproved private subresource" in TASK-145's
    // acceptance criteria means to block.
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        callback({});
        return;
      }
      callback({ cancel: Boolean(previewAccessBlockedReason(details.url, previewAccess)) });
    });

    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' })); // a preview never spawns a new window
    const guard = (event: Electron.Event, url: string): void => {
      if (previewAccessBlockedReason(url, previewAccess)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    return view;
  }

  attach(win: BrowserWindow): void {
    this.ensure(win);
  }

  setBounds(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    const view = this.ensure(win);
    this.lastBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    };
    view.setBounds(this.lastBounds);
  }

  /** Hiding the view — what the renderer does when the user closes the preview tab. Deliberately touches nothing in `runManagerInstance.ts`. */
  setVisible(win: BrowserWindow, visible: boolean): void {
    const view = this.ensure(win);
    this.visible = visible;
    view.setVisible(visible);
  }

  private get wc(): Electron.WebContents {
    return this.ensure(this.hostWindow()).webContents;
  }

  async open(url: string): Promise<void> {
    const reason = previewAccessBlockedReason(url, previewAccess);
    if (reason) throw new Error(reason);
    await this.wc.loadURL(url);
  }

  currentUrl(): string | undefined {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getURL() : undefined;
  }
}

let manager: PreviewBrowserManager | undefined;

export function getPreviewBrowser(): PreviewBrowserManager {
  if (!manager) manager = new PreviewBrowserManager();
  return manager;
}
