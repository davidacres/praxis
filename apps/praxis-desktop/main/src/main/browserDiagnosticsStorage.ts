import { app } from 'electron';
import * as path from 'node:path';

/** `userData/browser-diagnostics/` — isolated per profile; see `browserDiagnostics.ts` (core) for the tree shape beneath it. */
export function browserDiagnosticsStorageRoot(): string {
  return path.join(app.getPath('userData'), 'browser-diagnostics');
}
