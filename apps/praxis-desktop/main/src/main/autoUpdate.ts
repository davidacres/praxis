import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import type { LogSink, UpdateStatus } from '@praxis/core';

/**
 * Automatic updates from the GitHub Releases feed.
 *
 * `electron-updater` reads the feed electron-builder bakes into
 * `resources/app-update.yml` from the `publish` config. A packaged build checks
 * shortly after launch and then periodically; when a newer release exists and
 * this build can apply it, the update downloads in the background and installs
 * on the next quit — or immediately if the user picks "Restart to update".
 *
 * - **Nothing runs in development or without a feed.** An unpackaged app has no
 *   update metadata to compare against, so a check would only produce noise; it
 *   is skipped rather than attempted and swallowed.
 * - **A macOS build must be Developer ID signed for updates to install.**
 *   Squirrel.Mac refuses anything else. Such a build still *finds* updates and
 *   points at the release page instead of silently failing to apply them.
 *
 * The renderer is told what happened either way, so "you are up to date" and
 * "an update exists but this build cannot install it" are distinguishable.
 */

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The slice of electron-updater's `autoUpdater` the controller drives. */
export interface UpdaterPort {
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  onDownloadProgress(listener: (percent: number) => void): void;
}

interface ElectronAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): void;
}

export interface UpdateControllerDeps {
  currentVersion: string;
  /** Set when this build cannot check at all (development, no feed, disabled). */
  unsupportedReason?: string;
  canInstall(): Promise<boolean>;
  releaseUrl(version: string): string | undefined;
  loadUpdater(): Promise<UpdaterPort>;
  publish(status: UpdateStatus): void;
  log(line: string): void;
}

export class UpdateController {
  private status: UpdateStatus;
  private updater?: Promise<UpdaterPort>;
  private checking?: Promise<UpdateStatus>;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.status = deps.unsupportedReason
      ? { state: 'unsupported', reason: deps.unsupportedReason }
      : { state: 'unsupported', reason: 'Update checking has not run yet.' };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Checks the feed and, when the update can be applied, downloads it. */
  check(): Promise<UpdateStatus> {
    if (this.deps.unsupportedReason) {
      this.set({ state: 'unsupported', reason: this.deps.unsupportedReason });
      return Promise.resolve(this.status);
    }
    // A download in progress or waiting for a restart already has the newest
    // release; re-checking would only flicker the status back to "checking".
    if (this.status.state === 'downloading' || this.status.state === 'ready') {
      return Promise.resolve(this.status);
    }
    this.checking ??= this.runCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async download(): Promise<UpdateStatus> {
    const status = this.status;
    if (status.state !== 'available' || !status.canInstall) return status;
    const { version } = status;
    try {
      const updater = await this.loadUpdater();
      this.set({ state: 'downloading', version, percent: 0 });
      await updater.downloadUpdate();
      this.set({ state: 'ready', version });
    } catch (error) {
      this.fail('download', error);
    }
    return this.status;
  }

  async installNow(): Promise<UpdateStatus> {
    if (this.status.state !== 'ready') return this.status;
    // Quits and relaunches into the new version.
    (await this.loadUpdater()).quitAndInstall();
    return this.status;
  }

  private async runCheck(): Promise<UpdateStatus> {
    try {
      this.set({ state: 'checking' });
      const updater = await this.loadUpdater();
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.set({ state: 'current', version: this.deps.currentVersion });
        return this.status;
      }
      const version = result.updateInfo.version;
      const canInstall = await this.deps.canInstall();
      this.set({ state: 'available', version, canInstall, releaseUrl: this.deps.releaseUrl(version) });
      if (canInstall) await this.download();
    } catch (error) {
      this.fail('check', error);
    }
    return this.status;
  }

  private loadUpdater(): Promise<UpdaterPort> {
    this.updater ??= this.deps.loadUpdater().then(updater => {
      updater.onDownloadProgress(percent => {
        if (this.status.state === 'downloading') {
          this.set({ state: 'downloading', version: this.status.version, percent: Math.round(percent) });
        }
      });
      return updater;
    });
    return this.updater;
  }

  private fail(step: 'check' | 'download', error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log(`[update] ${step} failed: ${message}`);
    this.set({ state: 'error', message });
  }

  private set(next: UpdateStatus): void {
    this.status = next;
    this.deps.publish(next);
  }
}

function updateFeedPath(): string {
  return path.join(process.resourcesPath, 'app-update.yml');
}

/** Why this build cannot check for updates, or undefined when it can. */
function unsupportedReason(): string | undefined {
  if (!app.isPackaged) {
    return 'Updates are only checked in a packaged build.';
  }
  if (process.env.PRAXIS_DISABLE_UPDATES === '1') {
    return 'Update checking is disabled by PRAXIS_DISABLE_UPDATES.';
  }
  if (!existsSync(updateFeedPath())) {
    return 'This build was packaged without an update feed.';
  }
  return undefined;
}

/** The GitHub release page for `version`, read from the baked-in feed config. */
export function githubReleaseUrl(feedYaml: string, version: string): string | undefined {
  const field = (name: string) => new RegExp(`^${name}:\\s*['"]?([^'"\\s]+)`, 'm').exec(feedYaml)?.[1];
  if (field('provider') !== 'github') return undefined;
  const owner = field('owner');
  const repo = field('repo');
  return owner && repo ? `https://github.com/${owner}/${repo}/releases/tag/v${version}` : undefined;
}

export function resolveElectronAutoUpdater(imported: unknown): ElectronAutoUpdater {
  const module = imported as {
    autoUpdater?: ElectronAutoUpdater;
    default?: { autoUpdater?: ElectronAutoUpdater };
  };
  const updater = module.autoUpdater ?? module.default?.autoUpdater;
  if (!updater) throw new Error('electron-updater did not expose autoUpdater.');
  return updater;
}

/**
 * macOS installs updates through Squirrel.Mac, which requires a Developer ID
 * signed bundle. An ad-hoc or unsigned build can still find an update; it just
 * cannot apply one. Windows and Linux updaters have no such requirement.
 */
let macSigned: Promise<boolean> | undefined;
function canInstallUpdates(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  if (process.mas || process.env.PRAXIS_MAC_SIGNED === '1') return Promise.resolve(true);
  macSigned ??= new Promise(resolve => {
    const bundle = path.resolve(app.getPath('exe'), '../../..');
    execFile('codesign', ['-dv', '--verbose=2', bundle], (_error, stdout, stderr) => {
      resolve(/Authority=Developer ID Application/.test(`${stdout}${stderr}`));
    });
  });
  return macSigned;
}

async function loadElectronUpdater(): Promise<UpdaterPort> {
  const autoUpdater = resolveElectronAutoUpdater(await import('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  return {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onDownloadProgress: listener => { autoUpdater.on('download-progress', progress => listener(progress.percent)); }
  };
}

export function registerAutoUpdate(windows: () => BrowserWindow[], logger: LogSink): void {
  const reason = unsupportedReason();
  const feedYaml = reason ? '' : readFileSync(updateFeedPath(), 'utf8');
  const controller = new UpdateController({
    currentVersion: app.getVersion(),
    unsupportedReason: reason,
    canInstall: canInstallUpdates,
    releaseUrl: version => githubReleaseUrl(feedYaml, version),
    loadUpdater: loadElectronUpdater,
    publish: status => {
      for (const win of windows()) {
        if (!win.isDestroyed()) win.webContents.send('update:status', status);
      }
    },
    log: line => logger.appendLine(line)
  });

  ipcMain.handle('update:getStatus', () => controller.getStatus());
  ipcMain.handle('update:check', () => controller.check());
  ipcMain.handle('update:download', () => controller.download());
  ipcMain.handle('update:installNow', () => controller.installNow());

  if (reason) {
    logger.appendLine(`[update] ${reason}`);
    return;
  }
  setTimeout(() => void controller.check(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void controller.check(), CHECK_INTERVAL_MS);
}
