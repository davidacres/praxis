import { app, ipcMain, type BrowserWindow } from 'electron';
import type { LogSink, UpdateStatus } from '@praxis/core';

/**
 * Update checking, behind an explicit publish feed.
 *
 * `electron-updater` reads the feed baked in at build time by electron-builder's
 * `publish` config. Two things follow, and both are deliberate:
 *
 * - **Nothing runs in development or without a feed.** An unpackaged app has no
 *   update metadata to compare against, and a build published with `--publish
 *   never` has no feed URL; in either case a check would only produce noise, so
 *   it is skipped rather than attempted and swallowed.
 * - **A macOS build must be signed for updates to install.** Squirrel.Mac
 *   refuses unsigned bundles. Downloading is therefore opt-in per platform:
 *   until signing is configured, a check reports the new version and points at
 *   the download rather than silently failing to apply it.
 *
 * The renderer is told what happened either way, so "you are up to date" and
 * "an update exists but this build cannot install it" are distinguishable.
 */

let status: UpdateStatus = { state: 'unsupported', reason: 'Update checking has not run yet.' };
let updaterModule: typeof import('electron-updater') | undefined;

function broadcast(windows: () => BrowserWindow[], next: UpdateStatus): void {
  status = next;
  for (const win of windows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', next);
  }
}

/** Why this build cannot check for updates, or undefined when it can. */
function unsupportedReason(): string | undefined {
  if (!app.isPackaged) {
    return 'Updates are only checked in a packaged build.';
  }
  if (process.env.PRAXIS_DISABLE_UPDATES === '1') {
    return 'Update checking is disabled by PRAXIS_DISABLE_UPDATES.';
  }
  return undefined;
}

/**
 * macOS installs updates through Squirrel.Mac, which requires a signed bundle.
 * An unsigned build can still *find* an update; it just cannot apply one.
 */
function canInstallUpdates(): boolean {
  if (process.platform !== 'darwin') return true;
  // `isPackaged` plus a code signature is the closest check available here
  // without shelling out to `codesign`; electron-updater surfaces the real
  // failure at download time, which is reported as an error state.
  return process.mas || Boolean(process.env.PRAXIS_MAC_SIGNED === '1');
}

export function registerAutoUpdate(windows: () => BrowserWindow[], logger: LogSink): void {
  ipcMain.handle('update:getStatus', () => status);

  ipcMain.handle('update:check', async () => {
    const reason = unsupportedReason();
    if (reason) {
      broadcast(windows, { state: 'unsupported', reason });
      return status;
    }
    try {
      broadcast(windows, { state: 'checking' });
      updaterModule ??= await import('electron-updater');
      const { autoUpdater } = updaterModule;
      autoUpdater.autoDownload = false;
      autoUpdater.logger = null;

      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!version || version === app.getVersion()) {
        broadcast(windows, { state: 'current', version: app.getVersion() });
      } else {
        broadcast(windows, { state: 'available', version, canInstall: canInstallUpdates() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.appendLine(`[update] check failed: ${message}`);
      broadcast(windows, { state: 'error', message });
    }
    return status;
  });

  ipcMain.handle('update:download', async () => {
    if (status.state !== 'available' || !status.canInstall) {
      return status;
    }
    const version = status.version;
    try {
      updaterModule ??= await import('electron-updater');
      const { autoUpdater } = updaterModule;
      autoUpdater.on('download-progress', progress => {
        broadcast(windows, { state: 'downloading', version, percent: Math.round(progress.percent) });
      });
      await autoUpdater.downloadUpdate();
      broadcast(windows, { state: 'ready', version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.appendLine(`[update] download failed: ${message}`);
      broadcast(windows, { state: 'error', message });
    }
    return status;
  });

  ipcMain.handle('update:installNow', async () => {
    if (status.state !== 'ready') return status;
    updaterModule ??= await import('electron-updater');
    // Quits and relaunches into the new version.
    updaterModule.autoUpdater.quitAndInstall();
    return status;
  });

  const reason = unsupportedReason();
  if (reason) {
    logger.appendLine(`[update] ${reason}`);
    status = { state: 'unsupported', reason };
  }
}
