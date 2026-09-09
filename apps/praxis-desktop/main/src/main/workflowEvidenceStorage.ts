import { app } from 'electron';
import * as path from 'node:path';

/** `userData/workflow-evidence/` — isolated per profile; see `workflowEvidence.ts` (core) for the tree shape beneath it. */
export function evidenceStorageRoot(): string {
  return path.join(app.getPath('userData'), 'workflow-evidence');
}
