import type { AiProvider, ProviderUsageHistory } from '@praxis/core';

// A query boundary, deliberately not presented as account creation or complete retention.
export const HISTORY_FROM = '2020-01-01T00:00:00.000Z';
const HISTORY_NOTE = 'Provider account usage can include other apps and devices. Coverage depends on the history retained by the provider.';

type UsagePage = {
  data?: Array<{ start_time?: number; starting_at?: string; results?: Array<Record<string, unknown>> }>;
  has_more?: boolean;
  next_page?: string | null;
};

function tokens(result: Record<string, unknown>, provider: AiProvider): number {
  const fields = provider === 'anthropic'
    ? ['uncached_input_tokens', 'output_tokens', 'cache_read_input_tokens']
    : ['input_tokens', 'output_tokens'];
  const cache = result.cache_creation as Record<string, unknown> | undefined;
  const cacheTokens = provider === 'anthropic' ? ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'].reduce((sum, field) => {
    const value = cache?.[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Provider returned invalid cache usage.');
    return sum + value;
  }, 0) : 0;
  return fields.reduce((sum, field) => {
    const value = result[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Provider returned invalid token usage.');
    return sum + value;
  }, cacheTokens);
}

/** Complete every page or fail: a partial download must never appear as a cumulative total. */
export async function fetchApiUsageHistory(provider: 'openai' | 'anthropic', key: string, fetcher: typeof fetch = fetch): Promise<ProviderUsageHistory> {
  const fetchedAt = new Date().toISOString();
  const url = new URL(provider === 'openai'
    ? 'https://api.openai.com/v1/organization/usage/completions'
    : 'https://api.anthropic.com/v1/organizations/usage_report/messages');
  if (provider === 'openai') {
    url.searchParams.set('start_time', String(Date.parse(HISTORY_FROM) / 1000));
    url.searchParams.set('end_time', String(Math.floor(Date.parse(fetchedAt) / 1000)));
  } else {
    url.searchParams.set('starting_at', HISTORY_FROM);
    url.searchParams.set('ending_at', fetchedAt);
  }
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', '31');
  const headers: Record<string, string> = provider === 'openai'
    ? { Authorization: `Bearer ${key}` }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const signal = AbortSignal.timeout(120_000);
  const seen = new Set<string>();
  let totalTokens = 0;
  let firstUsageAt: string | undefined;
  for (let page = 0; page < 200; page++) {
    const response = await fetcher(url.toString(), { headers, signal });
    if (!response.ok) throw new Error(`Historical usage request failed (${response.status}). Check the admin credential and provider access.`);
    const body = await response.json() as UsagePage;
    if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new Error('Provider returned an invalid history page.');
    for (const bucket of body.data) {
      if (!Array.isArray(bucket.results)) throw new Error('Provider returned an invalid usage bucket.');
      const count = bucket.results.reduce((sum, result) => sum + tokens(result, provider), 0);
      totalTokens += count;
      const at = provider === 'openai' ? (bucket.start_time ?? NaN) * 1000 : Date.parse(bucket.starting_at ?? '');
      if (count > 0 && Number.isFinite(at)) {
        const iso = new Date(at).toISOString();
        if (!firstUsageAt || iso < firstUsageAt) firstUsageAt = iso;
      }
    }
    if (!body.has_more) return { provider, fetchedAt, source: 'provider-api', requestedFrom: HISTORY_FROM, requestedTo: fetchedAt, firstUsageAt, totalTokens, note: HISTORY_NOTE };
    if (!body.next_page || seen.has(body.next_page)) throw new Error('Provider history pagination did not advance.');
    seen.add(body.next_page);
    url.searchParams.set('page', body.next_page);
  }
  throw new Error('Provider history exceeded the download limit. No partial total is shown.');
}
