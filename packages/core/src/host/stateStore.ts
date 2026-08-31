/**
 * A synchronous key/value store. The Electron adapter backs this with a JSON
 * file under `app.getPath('userData')` (global) or
 * `userData/projects/<id>/state.json` (workspace/project-scoped).
 */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

export interface HostStorage {
  global: KeyValueStore;
  workspace: KeyValueStore;
}
