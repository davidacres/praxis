import { ipcMain } from 'electron';
import {
  compareLatestPeriod,
  hasReportableUsage,
  usageSeries,
  type AgentSessionRecord,
  type AiUsageEventInput,
  type UsageGranularity
} from '@praxis/core';
import { getAiUsageLog } from './aiUsageLogInstance';
import { getAiSessionManager } from './aiInstance';

/**
 * Registers the read-side `aiUsage:*` handlers — see `AiUsageIpc` in
 * `ipcContracts.ts` for why there's no renderer-facing write method.
 */
export function registerAiUsageIpc(): void {
  ipcMain.handle('aiUsage:series', async (_event, granularity: UsageGranularity, periodsBack: number) =>
    usageSeries(getAiUsageLog().list(), granularity, periodsBack)
  );
  ipcMain.handle('aiUsage:compareLatestPeriod', async (_event, granularity: UsageGranularity) =>
    compareLatestPeriod(getAiUsageLog().list(), granularity)
  );
  ipcMain.handle('aiUsage:listEvents', async () => getAiUsageLog().list());
}

/**
 * Diffs each session-record change against the last totals seen for that
 * session and logs only the delta — `AgentSessionRecord.tokenUsage` /
 * `.cost` are running totals (see `aiSessionManager.ts`'s own docs), not
 * per-turn deltas, so turning them into a time series means tracking what
 * "last totals" were ourselves. One entry per distinct `sessionId` this
 * process has observed; never cleared on session deletion — a desktop app's
 * lifetime session count is small enough that this isn't a real leak, and
 * hooking every deletion path to prune it isn't worth the coupling.
 */
const lastSeenTotals = new Map<
  string,
  { totalTokens: number; inputTokens: number; outputTokens: number; costAmount: number; costCurrency?: string }
>();

function trackSessionUsage(record: AgentSessionRecord): void {
  const previous = lastSeenTotals.get(record.sessionId) ?? {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costAmount: 0,
    costCurrency: undefined
  };

  const currentTotal = record.tokenUsage?.totalTokens ?? 0;
  const currentInput = record.tokenUsage?.inputTokens ?? 0;
  const currentOutput = record.tokenUsage?.outputTokens ?? 0;
  const currentCostAmount = record.cost?.amount ?? 0;
  const currentCostCurrency = record.cost?.currency;

  // A mid-session currency change shouldn't happen, but guard rather than
  // report a nonsense delta across two different currencies if it ever does.
  const currencyStable = !previous.costCurrency || !currentCostCurrency || previous.costCurrency === currentCostCurrency;
  const deltaCost = currencyStable && currentCostCurrency ? currentCostAmount - previous.costAmount : 0;

  lastSeenTotals.set(record.sessionId, {
    totalTokens: currentTotal,
    inputTokens: currentInput,
    outputTokens: currentOutput,
    costAmount: currentCostAmount,
    costCurrency: currentCostCurrency
  });

  const event: AiUsageEventInput = {
    source: 'session',
    sessionId: record.sessionId,
    provider: record.provider,
    model: record.model,
    inputTokens: currentInput - previous.inputTokens || undefined,
    outputTokens: currentOutput - previous.outputTokens || undefined,
    totalTokens: currentTotal - previous.totalTokens || undefined,
    cost: deltaCost ? { amount: deltaCost, currency: currentCostCurrency! } : undefined,
    workflowRunId: record.workflowRunId,
    workflowNodeId: record.workflowNodeId
  };
  if (!hasReportableUsage(event)) {
    return;
  }
  void getAiUsageLog().record(event);
}

/** Starts logging every session's usage deltas into the ledger. Call once at app startup. */
export function startAiUsageTracking(): void {
  getAiSessionManager().onDidChangeAgentSession(trackSessionUsage);
}
