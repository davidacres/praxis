import * as path from 'node:path';
import { app } from 'electron';
import { AiUsageLog } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let usageLog: AiUsageLog | undefined;

/**
 * Shared `AiUsageLog` singleton — `userData/ai-usage-log.json`, same
 * per-profile isolation as `aiInstance.ts`'s session/analysis stores (honours
 * `--user-data-dir`, so the Playwright suite's throwaway profiles never see
 * each other's usage history).
 */
export function getAiUsageLog(): AiUsageLog {
  if (!usageLog) {
    usageLog = new AiUsageLog(new JsonKeyValueStore(path.join(app.getPath('userData'), 'ai-usage-log.json')));
  }
  return usageLog;
}

/** Drops the file-backed singleton after its file is cleared by a reset. */
export function resetAiUsageLog(): void {
  usageLog = undefined;
}
