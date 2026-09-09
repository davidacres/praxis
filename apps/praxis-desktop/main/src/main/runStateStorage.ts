import { app } from 'electron';
import * as path from 'node:path';

/** `userData/run-state/` — isolated per profile; see `runReconciliation.ts` (core) for the tree shape beneath it. */
export function runStateStorageRoot(): string {
  return path.join(app.getPath('userData'), 'run-state');
}
