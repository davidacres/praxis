import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Emitter, sanitizeAppSettings, mergeAppSettings, resolveSharedSettingsPath } from '@praxis/core';
import type { AppSettings, AppSettingsPatch } from '@praxis/core';
import type { SettingsBackend } from '@praxis/core';
import { withJsonFileWrite } from './jsonFileWrites';

/**
 * Electron-side implementation of the shared `SettingsBackend`. Reads/writes a
 * single JSON document at the platform-specific path computed by
 * `resolveSharedSettingsPath` so the Electron app and the VS Code extension
 * see the same values.
 *
 * Writes are atomic (tmp + rename) so a concurrent VS Code watcher never
 * observes a half-written document. Watcher echoes are deduplicated by
 * value, so an external edit immediately after a local save is still observed.
 */
export class SharedSettingsBackend implements SettingsBackend {
  private readonly filePath: string;
  private current: AppSettings;
  private committed: AppSettings;
  private readonly pending: AppSettingsPatch[] = [];
  private readonly onDidChangeEmitter = new Emitter<AppSettings>();
  private watcher: fs.FSWatcher | undefined;
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
    this.current = sanitizeAppSettings(this.readFromDisk());
    this.committed = this.current;
    this.watch();
  }

  public read(): AppSettings {
    return this.current;
  }

  public async write(patch: AppSettingsPatch): Promise<AppSettings> {
    // Merge and assign `current` synchronously: with the old order (assign after
    // `await persist`), two overlapping writes both merged over the stale base
    // and the slower write clobbered the faster one's fields on disk.
    const operation = structuredClone(patch);
    this.pending.push(operation);
    this.rebuild();
    const write = this.persistQueue.then(async () => {
      const next = sanitizeAppSettings(mergeAppSettings(this.committed, operation));
      try {
        await this.persist(next);
        this.committed = next;
      } finally {
        this.pending.splice(this.pending.indexOf(operation), 1);
        this.rebuild();
      }
      this.onDidChangeEmitter.fire(next);
      return next;
    });
    this.persistQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  private rebuild(): void {
    this.current = this.pending.reduce<AppSettings>((value, patch) => sanitizeAppSettings(mergeAppSettings(value, patch)), this.committed);
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

  private persist(settings: AppSettings): Promise<void> {
    return withJsonFileWrite(this.filePath, async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      // Preserve connection/board keys owned by the other adapter of this document.
      const disk = this.readFromDisk();
      const next = isRecord(disk) ? { ...disk, ...settings } : settings;
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
        await fsp.rename(tempPath, this.filePath);
      } finally {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
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
    if (this.pending.length) {
      this.debounceTimer = setTimeout(() => this.handleExternalChange(), 150);
      return;
    }
    const next = sanitizeAppSettings(this.readFromDisk());
    if (JSON.stringify(next) === JSON.stringify(this.current)) {
      return;
    }
    this.current = next;
    this.committed = next;
    this.onDidChangeEmitter.fire(next);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
