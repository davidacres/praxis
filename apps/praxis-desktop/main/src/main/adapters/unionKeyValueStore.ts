import type { KeyValueStore } from '@praxis/core';

/** One additional file a unioned key's records may live in. */
export interface UnionScope {
  id: string;
  store: KeyValueStore;
}

export interface UnionKeyValueStoreOptions {
  /** The app's own file — the home for anything not claimed by a scope. */
  base: KeyValueStore;
  /** Scopes are resolved per call so a workspace opened mid-session is picked up. */
  scopes: () => UnionScope[];
  /**
   * Keys whose value is an array of records that may be split across files.
   * Every other key is passed straight through to `base`.
   */
  unionedKeys: ReadonlySet<string>;
  /** Stable identity of a record, used to work out which file it came from. */
  identify: (key: string, item: unknown) => string | undefined;
  /** Scope that adopts records seen for the first time. Undefined means `base`. */
  preferredScope: () => string | undefined;
}

/**
 * A `KeyValueStore` whose records may be spread over several files.
 *
 * `ProjectStore` and `ConnectionStore` each read and write a whole array under
 * one key, which is exactly right when there is one file. A workspace kept
 * outside the app owns its own projects and connections, so those arrays now
 * span the app's file plus one file per open workspace. Rather than teach both
 * stores about locations, this presents the union as a single store: reads
 * concatenate, and writes are split back to the file each record came from.
 *
 * A record whose id is not yet on disk is new, and goes to `preferredScope` —
 * the active workspace — so work started inside a located workspace is stored
 * with it rather than in the app's user folder.
 */
export class UnionKeyValueStore implements KeyValueStore {
  public constructor(private readonly options: UnionKeyValueStoreOptions) {}

  public get<T>(key: string): T | undefined {
    if (!this.options.unionedKeys.has(key)) {
      return this.options.base.get<T>(key);
    }
    const merged = [...(this.options.base.get<unknown[]>(key) ?? [])];
    for (const scope of this.options.scopes()) {
      merged.push(...(scope.store.get<unknown[]>(key) ?? []));
    }
    // A file opened from disk may replace an older app-local copy with the
    // same id. Later scopes win, preventing duplicate workspaces/projects.
    const keyed = new Map<string, unknown>();
    const unkeyed: unknown[] = [];
    for (const item of merged) {
      const id = this.options.identify(key, item);
      if (id === undefined) unkeyed.push(item);
      else keyed.set(id, item);
    }
    return [...keyed.values(), ...unkeyed] as unknown as T;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (!this.options.unionedKeys.has(key) || !Array.isArray(value)) {
      return this.options.base.update(key, value);
    }

    const scopes = this.options.scopes();
    const owner = new Map<string, string | undefined>();
    for (const item of this.options.base.get<unknown[]>(key) ?? []) {
      const id = this.options.identify(key, item);
      if (id !== undefined) owner.set(id, undefined);
    }
    for (const scope of scopes) {
      for (const item of scope.store.get<unknown[]>(key) ?? []) {
        const id = this.options.identify(key, item);
        if (id !== undefined) owner.set(id, scope.id);
      }
    }

    const preferred = this.options.preferredScope();
    const adopts = preferred !== undefined && scopes.some(scope => scope.id === preferred)
      ? preferred
      : undefined;
    const buckets = new Map<string | undefined, unknown[]>([[undefined, []]]);
    for (const scope of scopes) buckets.set(scope.id, []);
    for (const item of value) {
      const id = this.options.identify(key, item);
      const home = id !== undefined && owner.has(id) ? owner.get(id) : adopts;
      (buckets.get(home) ?? buckets.get(undefined)!).push(item);
    }

    // Only write a file whose slice actually changed. Without this every
    // project edit would rewrite every open workspace file, which for one kept
    // in a repo means a spurious diff on each keystroke.
    await this.writeIfChanged(this.options.base, key, buckets.get(undefined) ?? []);
    for (const scope of scopes) {
      await this.writeIfChanged(scope.store, key, buckets.get(scope.id) ?? []);
    }
  }

  private async writeIfChanged(store: KeyValueStore, key: string, next: unknown[]): Promise<void> {
    const current = store.get<unknown[]>(key) ?? [];
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    await store.update(key, next);
  }
}

/** Identity for the record kinds that can live in a workspace file. */
export function identifyStoredRecord(key: string, item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;
  // A tracked board is identified by the pair, not by an `id` field it lacks.
  if (typeof record.connectionId === 'string' && typeof record.boardId === 'string') {
    return `${record.connectionId}:${record.boardId}`;
  }
  return typeof record.id === 'string' ? record.id : undefined;
}
