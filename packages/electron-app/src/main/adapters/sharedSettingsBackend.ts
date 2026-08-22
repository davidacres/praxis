import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Emitter, sanitizeAppSettings, mergeAppSettings, resolveSharedSettingsPath } from '@ticket-manager/core';
import type { AppSettings, AppSettingsPatch } from '@ticket-manager/core';
import type { SettingsBackend } from '@ticket-manager/core';

/**
 * Electron-side implementation of the shared `SettingsBackend`. Reads/writes a
 * single JSON document at the platform-specific path computed by
 * `resolveSharedSettingsPath` so the Electron app and the VS Code extension
 * see the same values.
 *
 * Writes are atomic (tmp + rename) so a concurrent VS Code watcher never
 * observes a half-written document. Self-writes are suppressed via a short
 * timestamp guard so the writer doesn't bounce off its own event.
 */
export class SharedSettingsBackend implements SettingsBackend {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private current: AppSettings;
  private readonly onDidChangeEmitter = new Emitter<AppSettings>();
  private watcher: fs.FSWatcher | undefined;
  private suppressUntil = 0;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  public constructor(filePath?: string) {
    this.filePath = filePath
      ?? resolveSharedSettingsPath(process.platform, {
        APPDATA: process.env.APPDATA,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        home: os.homedir()
      });
    this.tmpPath = `${this.filePath}.tmp`;
    this.current = sanitizeAppSettings(this.readFromDisk());
    this.watch();
  }

  public read(): AppSettings {
    return this.current;
  }

  public async write(patch: AppSettingsPatch): Promise<AppSettings> {
    const merged = mergeAppSettings(this.current, patch);
    const sanitized = sanitizeAppSettings(merged);
    await this.persist(sanitized);
    this.current = sanitized;
    // Suppress the imminent watcher event echoing back from disk.
    this.suppressUntil = Date.now() + 500;
    this.onDidChangeEmitter.fire(sanitized);
    return sanitized;
  }

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.watcher?.close();
    this.onDidChangeEmitter.dispose();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  private readFromDisk(): unknown {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return undefined;
      }
      // Corrupt JSON or unreadable file — fall back to defaults rather than crash.
      return undefined;
    }
  }

  private async persist(settings: AppSettings): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const text = JSON.stringify(settings, null, 2);
    await fsp.writeFile(this.tmpPath, text, 'utf8');
    await fsp.rename(this.tmpPath, this.filePath);
  }

  /**
   * Watch the parent directory (not the file directly) because Windows
   * `fs.watch` on a single file is unreliable across atomic renames. Filter
   * events by basename and debounce so a single external save produces exactly
   * one read.
   */
  private watch(): void {
    try {
      this.watcher = fs.watch(path.dirname(this.filePath), { persistent: false }, (_event, filename) => {
        if (filename && filename !== path.basename(this.filePath)) {
          return;
        }
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.handleExternalChange(), 150);
      });
    } catch {
      // Watching is best-effort — the app still works without it.
    }
  }

  private handleExternalChange(): void {
    if (this.disposed) {
      return;
    }
    if (Date.now() < this.suppressUntil) {
      return;
    }
    const next = sanitizeAppSettings(this.readFromDisk());
    if (JSON.stringify(next) === JSON.stringify(this.current)) {
      return;
    }
    this.current = next;
    this.onDidChangeEmitter.fire(next);
  }
}
