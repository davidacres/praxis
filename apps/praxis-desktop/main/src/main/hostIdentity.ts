import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

const STORAGE_KEY = 'praxis.hostId';

let cached: string | undefined;

/**
 * This installation's stable host ID.
 *
 * Gadget scopes are pinned to the host that issued them, so an action answered
 * against one machine cannot be applied on another. That only means anything if
 * the ID survives a restart, hence the file rather than a process-lifetime
 * value. It lives under `userData`, so the e2e suite's throwaway profile gets
 * its own identity without needing an env override.
 */
export function getHostId(): string {
  if (cached) return cached;
  const store = new JsonKeyValueStore(path.join(app.getPath('userData'), 'host-identity.json'));
  const existing = store.get<string>(STORAGE_KEY);
  if (existing) {
    cached = existing;
    return cached;
  }
  cached = randomUUID();
  void store.update(STORAGE_KEY, cached);
  return cached;
}

/** Test seam — the ID is cached for the process lifetime. */
export function resetHostIdentity(): void {
  cached = undefined;
}
