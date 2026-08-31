import type { Event, Disposable } from './emitter';
import type { AppSettings, AppSettingsPatch } from '../config/appSettings';

/**
 * Settings store over a single JSON file at the path returned by
 * `resolveSharedSettingsPath`. The Electron adapter implements it with
 * `node:fs` + `fs.watch`.
 *
 * Implementations read eagerly at construction so the initial `read()` call is
 * synchronous and cheap; `write` is async because fs persistence is.
 */
export interface SettingsBackend extends Disposable {
  /**
   * Returns the current settings, merged over `DEFAULT_APP_SETTINGS`. Synchronous
   * because the file is loaded at construction; callers should never call `read`
   * before the backend is ready.
   */
  read(): AppSettings;
  /**
   * Applies a deep patch, persists atomically (tmp file + rename so external
   * watchers never see a torn write), and fires `onDidChange` once with the
   * merged result. Suppresses the corresponding watcher event on the local
   * file system so the writer doesn't bounce off its own write.
   */
  write(patch: AppSettingsPatch): Promise<AppSettings>;
  /**
   * Fires after every successful change — both locally-initiated `write`s and
   * external edits detected via the host's file watcher. Listeners receive the
   * post-merge settings snapshot.
   */
  readonly onDidChange: Event<AppSettings>;
}
