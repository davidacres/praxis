import {
  isCustomProviderId,
  secretKeyForProvider,
  type CustomProviderConfig,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow
} from '@praxis/core';
import { getSecretsStore } from './connectionStoreInstance';

/**
 * MiniMax account quota (FX-BF-044 follow-up). MiniMax is a custom endpoint
 * built from the `minimax` preset, so it has no `AiProvider` id of its own and
 * would otherwise fall through `aiUsageIpc`'s adapter registry to the generic
 * "no usage API" message. It does expose one: `GET /v1/token_plan/remains`,
 * bearer-authenticated with the same key the endpoint chats with.
 *
 * The payload's `*_usage_count` fields are *remaining* quota, not consumed
 * (a naming trap several third-party clients got wrong), so usage is
 * `total - usage_count`, and `*_remaining_percent` is preferred when present.
 */

const REMAINS_PATH = '/v1/token_plan/remains';

interface MiniMaxWindow {
  total?: number;
  remaining?: number;
  remainingPercent?: number;
  startTime?: number;
  endTime?: number;
}

/** MiniMax sends some numerics as strings ("96"), so accept both. */
function numberAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readWindow(entry: Record<string, unknown>, scope: 'interval' | 'weekly'): MiniMaxWindow {
  return {
    total: numberAt(entry[scope === 'interval' ? 'current_interval_total_count' : 'current_weekly_total_count']),
    remaining: numberAt(entry[scope === 'interval' ? 'current_interval_usage_count' : 'current_weekly_usage_count']),
    remainingPercent: numberAt(entry[scope === 'interval' ? 'current_interval_remaining_percent' : 'current_weekly_remaining_percent']),
    startTime: numberAt(entry[scope === 'interval' ? 'start_time' : 'weekly_start_time']),
    endTime: numberAt(entry[scope === 'interval' ? 'end_time' : 'weekly_end_time'])
  };
}

/**
 * One provider window as a percentage consumed. A percent field wins: the
 * counts are absent (zero) on the newer payloads. Falls back to
 * `total - remaining` only when the total is actually a limit rather than a
 * placeholder zero.
 */
function usedPercent(window: MiniMaxWindow): number | undefined {
  if (typeof window.remainingPercent === 'number') {
    return Math.min(100, Math.max(0, Math.round(100 - window.remainingPercent)));
  }
  const { total, remaining } = window;
  if (typeof total !== 'number' || typeof remaining !== 'number' || total <= 0) return undefined;
  const used = Math.max(0, Math.min(total, total - remaining));
  return Math.round((used / total) * 100);
}

function isoTime(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function durationMinutes(window: MiniMaxWindow): number | undefined {
  const { startTime, endTime } = window;
  if (typeof startTime !== 'number' || typeof endTime !== 'number' || endTime <= startTime) return undefined;
  return Math.round((endTime - startTime) / 60000);
}

function mapWindow(
  window: MiniMaxWindow,
  period: 'hour' | 'week',
  label: string
): ProviderUsageWindow | undefined {
  const percent = usedPercent(window);
  if (percent === undefined) return undefined;
  return {
    period,
    label,
    usedPercent: percent,
    windowDurationMinutes: durationMinutes(window),
    resetsAt: isoTime(window.endTime)
  };
}

/** Picks the entry with the most consumed quota — plans can report one row per model. */
function busiestEntry(entries: unknown[]): Record<string, unknown> {
  let best: Record<string, unknown> = {};
  let bestUsed = -1;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const window = readWindow(row, 'interval');
    const used = typeof window.total === 'number' && window.total > 0 && typeof window.remaining === 'number'
      ? window.total - window.remaining
      : (100 - (window.remainingPercent ?? 100));
    if (used > bestUsed) {
      bestUsed = used;
      best = row;
    }
  }
  return best;
}

/**
 * Pure part of the adapter: MiniMax's remains payload → a provider-neutral
 * snapshot. Exported for tests; the caller supplies the provider id because a
 * custom endpoint's is `custom:<slug>`.
 */
export function parseMiniMaxRemains(provider: CustomProviderConfig['id'], body: unknown): ProviderUsageSnapshot {
  const fetchedAt = new Date().toISOString();
  const unavailable = (reason: string, code: 'not-configured' | 'fetch-failed'): ProviderUsageSnapshot => ({ provider, fetchedAt, windows: [], unavailableReason: reason, unavailableReasonCode: code });
  if (!body || typeof body !== 'object') return unavailable('MiniMax returned a payload Praxis could not read.', 'fetch-failed');

  const record = body as Record<string, unknown>;
  const baseResp = record.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
  const statusCode = numberAt(baseResp?.status_code);
  if (typeof statusCode === 'number' && statusCode !== 0) {
    const message = typeof baseResp?.status_msg === 'string' && baseResp.status_msg.trim() ? baseResp.status_msg.trim() : `status ${statusCode}`;
    return unavailable(`MiniMax usage request failed: ${message}`, 'fetch-failed');
  }

  const data = (record.data ?? record) as Record<string, unknown>;
  const entries = Array.isArray(data.model_remains) ? data.model_remains : [];
  if (entries.length === 0) {
    return unavailable('MiniMax did not report any quota windows for this key. A pay-as-you-go key has no plan quota — only M Plan subscription keys do.', 'fetch-failed');
  }

  const entry = busiestEntry(entries);
  const plan = typeof data.current_subscribe_title === 'string' && data.current_subscribe_title.trim()
    ? data.current_subscribe_title.trim()
    : undefined;
  const windows = [
    mapWindow(readWindow(entry, 'interval'), 'hour', plan ? `${plan} · 5-hour window` : '5-hour window'),
    mapWindow(readWindow(entry, 'weekly'), 'week', plan ? `${plan} · weekly window` : 'Weekly window')
  ].filter((window): window is ProviderUsageWindow => Boolean(window));

  const pointsBalance = numberAt(data.points_balance);
  return {
    provider,
    fetchedAt,
    windows,
    credits: typeof pointsBalance === 'number' ? { remaining: pointsBalance, currency: 'points' } : undefined
  };
}

/** The endpoint's own base URL, so a China-region key keeps working. */
function remainsUrl(config: CustomProviderConfig): string {
  return `${config.baseUrl.replace(/\/$/, '')}${REMAINS_PATH}`;
}

/** Requests MiniMax's quota for one custom endpoint, using its stored chat key. */
export async function miniMaxUsageSnapshot(config: CustomProviderConfig): Promise<ProviderUsageSnapshot> {
  const fetchedAt = new Date().toISOString();
  // Same keychain entry the endpoint's own requests use — one key, one entry.
  const key = process.env.MINIMAX_API_KEY || await getSecretsStore().get(secretKeyForProvider(config.id));
  if (!key?.trim()) {
    return { provider: config.id, fetchedAt, windows: [], unavailableReason: 'Add a MiniMax API key to this endpoint to view plan usage.', unavailableReasonCode: 'not-configured' };
  }
  try {
    const response = await fetch(remainsUrl(config), {
      headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' }
    });
    if (response.status === 401 || response.status === 403) {
      return { provider: config.id, fetchedAt, windows: [], unavailableReason: 'MiniMax rejected this key for account usage. Plan quota needs an M Plan subscription key (sk-cp-…), not a pay-as-you-go key (sk-api-…).', unavailableReasonCode: 'not-configured' };
    }
    if (!response.ok) {
      return { provider: config.id, fetchedAt, windows: [], unavailableReason: `MiniMax usage request failed (${response.status}).`, unavailableReasonCode: 'fetch-failed' };
    }
    return parseMiniMaxRemains(config.id, await response.json());
  } catch (error) {
    return { provider: config.id, fetchedAt, windows: [], unavailableReason: error instanceof Error ? error.message : 'MiniMax account usage is unavailable.', unavailableReasonCode: 'fetch-failed' };
  }
}

/**
 * Narrows `config` to a MiniMax endpoint. Preset-derived, so an endpoint the
 * user pointed elsewhere is still matched on `presetId`, not on its URL.
 */
export function isMiniMaxEndpoint(
  provider: string,
  config: CustomProviderConfig | undefined
): config is CustomProviderConfig {
  return isCustomProviderId(provider) && config !== undefined && config.presetId === 'minimax';
}
