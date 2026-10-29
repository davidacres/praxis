import type { DeterministicFeedbackReport, ReviewFindingRequest } from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getSessionFeedbackStore } from './aiInstance';

// Bind labels to reports the host actually evaluated, rather than trusting a
// renderer-supplied finding or prompt snapshot. Persisted session reports remain valid.
const recent = new Map<string, DeterministicFeedbackReport>();
export function rememberFeedbackReport(report: DeterministicFeedbackReport): DeterministicFeedbackReport {
  recent.set(report.inputDigest, report);
  while (recent.size > 128) recent.delete(recent.keys().next().value!);
  return report;
}
export function registerFindingFeedbackIpc(): void {
  ipcMain.handle('ai:getFindingFeedback', (_event, digest: string) => getSessionFeedbackStore().getFindingFeedback(digest));
  ipcMain.handle('ai:reviewFinding', async (_event, input: ReviewFindingRequest) => {
    if (!input || typeof input.inputDigest !== 'string' || typeof input.findingId !== 'string' ||
      (input.muted !== undefined && typeof input.muted !== 'boolean')) throw new Error('Invalid finding review.');
    const store = getSessionFeedbackStore();
    const report = recent.get(input.inputDigest) ?? store.listReports().find(candidate => candidate.inputDigest === input.inputDigest);
    if (!report) throw new Error('This assessment has expired. Check the prompt again before rating it.');
    return store.reviewFinding(report, input);
  });
}
