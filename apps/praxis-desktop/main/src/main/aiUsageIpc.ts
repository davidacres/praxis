import { ipcMain } from 'electron';
import {
  compareLatestPeriod,
  dashboardUsageSummary,
  hasReportableUsage,
  periodStart as usagePeriodStart,
  usageSeries,
  type AgentSessionRecord,
  type AiUsageEventInput,
  type UsageDashboardSummary,
  type UsageGranularity,
  type AiProvider,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow
} from '@praxis/core';
import { getAiUsageLog } from './aiUsageLogInstance';
import { getAiSessionManager } from './aiInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { codexCliSnapshot } from './codexUsage';
import { claudeCodeSnapshot } from './claudeUsage';
import { isMiniMaxEndpoint, miniMaxUsageSnapshot } from './minimaxUsage';

const USAGE_SECRET_PREFIX = 'ai-usage:';

function periodStart(period: 'hour' | 'day' | 'week' | 'month'): number {
  const now = new Date();
  if (period === 'hour') now.setUTCMinutes(0, 0, 0);
  else if (period === 'day') now.setUTCHours(0, 0, 0, 0);
  else if (period === 'week') {
    now.setUTCHours(0, 0, 0, 0);
    const day = now.getUTCDay();
    now.setUTCDate(now.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else {
    now.setUTCDate(1);
    now.setUTCHours(0, 0, 0, 0);
  }
  return Math.floor(now.getTime() / 1000);
}

function apiRoot(provider: AiProvider): string {
  const settings = getSettingsBackend().read();
  const config = provider === 'vercel-gateway' ? undefined : settings.ai.providers[provider];
  return (provider === 'openai' ? config?.baseUrl : undefined)?.replace(/\/$/, '') || 'https://api.openai.com';
}

function numberAt(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = numberAt(candidate, ['value', 'amount', 'quantity']);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

async function openAiSnapshot(): Promise<ProviderUsageSnapshot> {
  const fetchedAt = new Date().toISOString();
  const key = process.env.OPENAI_ADMIN_KEY || await getSecretsStore().get(`${USAGE_SECRET_PREFIX}openai`);
  if (!key) return { provider: 'openai', fetchedAt, windows: [], unavailableReason: 'Add an OpenAI Admin API key to view account usage.' };
  const root = apiRoot('openai');
  const headers = { Authorization: `Bearer ${key}` };
  const periods: Array<'hour' | 'day' | 'week' | 'month'> = ['hour', 'day', 'week', 'month'];
  try {
    const windows: ProviderUsageWindow[] = await Promise.all(periods.map(async period => {
      const params = new URLSearchParams({
        start_time: String(periodStart(period)),
        bucket_width: period === 'hour' ? '1h' : '1d',
        group_by: 'model'
      });
      const response = await fetch(`${root}/v1/organization/usage/completions?${params}`, { headers });
      if (!response.ok) throw new Error(`OpenAI usage request failed (${response.status})`);
      const body = await response.json() as { data?: Array<{ results?: unknown[] }> };
      let tokens = 0;
      for (const bucket of body.data ?? []) {
        for (const result of bucket.results ?? []) {
          tokens += numberAt(result, ['total_tokens']) ?? ((numberAt(result, ['input_tokens']) ?? 0) + (numberAt(result, ['output_tokens']) ?? 0));
        }
      }
      return { period, usedTokens: tokens };
    }));
    // Costs are a separate Admin API resource. Keep this best-effort: token
    // usage is still useful when an account cannot read cost records.
    try {
      const params = new URLSearchParams({ start_time: String(periodStart('month')), bucket_width: '1d' });
      const response = await fetch(`${root}/v1/organization/costs?${params}`, { headers });
      if (response.ok) {
        const body = await response.json() as { data?: Array<{ results?: unknown[] }> };
        let amount = 0;
        for (const bucket of body.data ?? []) {
          for (const result of bucket.results ?? []) amount += numberAt(result, ['amount', 'cost']) ?? 0;
        }
        if (amount > 0) windows[3] = { ...windows[3], usedCost: amount, currency: 'USD' };
      }
    } catch {
      // Cost reporting is optional and must not hide token usage.
    }
    return { provider: 'openai', fetchedAt, windows };
  } catch (error) {
    return { provider: 'openai', fetchedAt, windows: [], unavailableReason: error instanceof Error ? error.message : 'OpenAI usage is unavailable.' };
  }
}

type ProviderUsageAdapter = () => Promise<ProviderUsageSnapshot>;
const providerUsageAdapters = new Map<AiProvider, ProviderUsageAdapter>();

/** Provider adapters stay behind this registry so adding Anthropic/Gemini/etc.
 * does not change the renderer contract or the session panel. */
export function registerProviderUsageAdapter(provider: AiProvider, adapter: ProviderUsageAdapter): void {
  providerUsageAdapters.set(provider, adapter);
}

/**
 * Custom endpoints have their own `AiProvider` ids, so they cannot be in the
 * adapter map. A few catalog presets do expose a vendor usage API anyway —
 * resolve those from the saved endpoint, which still knows which preset it was
 * created from.
 */
async function customEndpointSnapshot(provider: AiProvider): Promise<ProviderUsageSnapshot | undefined> {
  const config = getSettingsBackend().read().ai.customProviders?.find(endpoint => endpoint.id === provider);
  if (isMiniMaxEndpoint(provider, config)) return miniMaxUsageSnapshot(config);
  return undefined;
}

async function providerSnapshot(provider: AiProvider): Promise<ProviderUsageSnapshot> {
  const adapter = providerUsageAdapters.get(provider);
  if (adapter) return adapter();
  const custom = await customEndpointSnapshot(provider);
  if (custom) return custom;
  return { provider, fetchedAt: new Date().toISOString(), windows: [], unavailableReason: 'This provider does not expose an account usage API to Praxis yet.' };
}

let dashboardMemo: { key: string; summary: UsageDashboardSummary } | undefined;

/**
 * The summary rescans the whole ledger, and the Overview page asks for it on
 * every visit, so it is memoised. The key is the event count plus the last
 * event's id (the count alone stops changing once the ledger hits its cap) plus
 * the UTC hour, because "today" and the hourly peak move with the clock.
 */
export function dashboardSummary(): UsageDashboardSummary {
  const events = getAiUsageLog().list();
  const hour = usagePeriodStart(new Date(), 'hour').toISOString();
  const key = `${events.length}:${events[events.length - 1]?.id ?? ''}:${hour}`;
  if (dashboardMemo?.key !== key) dashboardMemo = { key, summary: dashboardUsageSummary(events) };
  return dashboardMemo.summary;
}

/**
 * Registers the read-side `aiUsage:*` handlers — see `AiUsageIpc` in
 * `ipcContracts.ts` for why there's no renderer-facing write method.
 */
export function registerAiUsageIpc(): void {
  registerProviderUsageAdapter('openai', openAiSnapshot);
  registerProviderUsageAdapter('codex-cli', codexCliSnapshot);
  registerProviderUsageAdapter('claude-code-cli', claudeCodeSnapshot);
  ipcMain.handle('aiUsage:series', async (_event, granularity: UsageGranularity, periodsBack: number) =>
    usageSeries(getAiUsageLog().list(), granularity, periodsBack)
  );
  ipcMain.handle('aiUsage:compareLatestPeriod', async (_event, granularity: UsageGranularity) =>
    compareLatestPeriod(getAiUsageLog().list(), granularity)
  );
  ipcMain.handle('aiUsage:dashboardSummary', async () => dashboardSummary());
  ipcMain.handle('aiUsage:listEvents', async () => getAiUsageLog().list());
  ipcMain.handle('aiUsage:providerSnapshot', async (_event, provider: AiProvider) => providerSnapshot(provider));
  ipcMain.handle('aiUsage:setProviderUsageKey', async (_event, provider: AiProvider, value: string) => {
    const key = `${USAGE_SECRET_PREFIX}${provider}`;
    if (value.trim()) await getSecretsStore().store(key, value.trim());
    else await getSecretsStore().delete(key);
  });
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
