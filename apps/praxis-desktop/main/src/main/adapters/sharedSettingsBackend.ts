import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Emitter, sanitizeAppSettings, mergeAppSettings, resolveSharedSettingsPath } from '@praxis/core';
import type { AppSettings, AppSettingsPatch } from '@praxis/core';
import type { SettingsBackend } from '@praxis/core';

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
  /** Serializes disk writes so two in-flight `write`s can't rename over each other. */
  private persistQueue: Promise<void> = Promise.resolve();

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
    // Merge and assign `current` synchronously: with the old order (assign after
    // `await persist`), two overlapping writes both merged over the stale base
    // and the slower write clobbered the faster one's fields on disk.
    const merged = mergeAppSettings(this.current, patch);
    const sanitized = sanitizeAppSettings(merged);
    this.current = sanitized;
    this.persistQueue = this.persistQueue.then(() => this.persist(sanitized));
    await this.persistQueue;
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

  /**
   * Serialises writes. `persistNow` is read-modify-write against a shared
   * document *and* stages through a single temp path, so two concurrent calls
   * both read the same base and the later rename silently discards the
   * earlier one's change. That surfaced as removing a connection appearing to
   * succeed and then the connection coming back: `removeConnection` writes the
   * connection list and the tracked-board list, and whichever landed second
   * restored what the first had deleted.
   *
   * Chaining makes each write observe the previous one's result. A failed
   * write must not poison the queue, so the chain continues either way.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  private persist(settings: AppSettings): Promise<void> {
    const run = this.writeQueue.then(
      () => this.persistNow(settings),
      () => this.persistNow(settings)
    );
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persistNow(settings: AppSettings): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // The connection/board store shares this JSON document but owns a few
    // extension keys that are intentionally outside AppSettings.  Merge the
    // latest on-disk record immediately before our atomic write so a settings
    // update cannot resurrect a connection that was just removed.
    const disk = this.readFromDisk();
    const next = isRecord(disk)
      ? { ...disk, ...settings }
      : settings;
    const text = JSON.stringify(next, null, 2);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
