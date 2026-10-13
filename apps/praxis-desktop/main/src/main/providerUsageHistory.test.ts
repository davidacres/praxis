import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchApiUsageHistory, HISTORY_FROM } from './providerUsageHistory';

function pages(responses: unknown[], requests: Array<{ url: URL; init?: RequestInit }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    requests.push({ url: new URL(url), init });
    const body = responses.shift();
    assert.ok(body, 'Unexpected extra request');
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test('OpenAI history follows pages, includes cached input once, and labels the requested coverage', async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const result = await fetchApiUsageHistory('openai', 'test-admin', pages([
    { data: [{ start_time: 1704067200, results: [{ input_tokens: 100, input_cached_tokens: 50, output_tokens: 20 }] }], has_more: true, next_page: 'page-2' },
    { data: [{ start_time: 1704153600, results: [{ input_tokens: 200, output_tokens: 30 }] }], has_more: false }
  ], requests));
  assert.equal(result.totalTokens, 350);
  assert.equal(result.firstUsageAt, '2024-01-01T00:00:00.000Z');
  assert.equal(result.requestedFrom, HISTORY_FROM);
  assert.equal(requests[1].url.searchParams.get('page'), 'page-2');
  assert.equal(requests[0].url.searchParams.get('end_time'), requests[1].url.searchParams.get('end_time'));
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer test-admin');
});

test('Anthropic history includes uncached, read cache, both write cache durations, and output', async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const result = await fetchApiUsageHistory('anthropic', 'test-admin', pages([
    { data: [{ starting_at: '2024-01-01T00:00:00Z', results: [{ uncached_input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 40 } }] }], has_more: false }
  ], requests));
  assert.equal(result.totalTokens, 390);
  assert.equal(requests[0].url.hostname, 'api.anthropic.com');
  assert.equal(requests[0].url.searchParams.get('starting_at'), HISTORY_FROM);
  assert.equal((requests[0].init?.headers as Record<string, string>)['x-api-key'], 'test-admin');
});

test('a failed later page never returns a partial total', async () => {
  let count = 0;
  const fetcher = (async () => ++count === 1
    ? new Response(JSON.stringify({ data: [{ start_time: 1704067200, results: [{ input_tokens: 100, output_tokens: 20 }] }], has_more: true, next_page: 'next' }))
    : new Response('', { status: 403 })) as typeof fetch;
  await assert.rejects(fetchApiUsageHistory('openai', 'test', fetcher), /403/);
});

test('empty history is a measured zero, while malformed history and looping pages fail', async () => {
  const result = await fetchApiUsageHistory('openai', 'test', pages([{ data: [], has_more: false }], []));
  assert.equal(result.totalTokens, 0);
  assert.equal(result.firstUsageAt, undefined);
  await assert.rejects(fetchApiUsageHistory('openai', 'test', pages([{ data: [{ results: [{ input_tokens: -1, output_tokens: 2 }] }], has_more: false }], [])), /invalid token/);
  await assert.rejects(fetchApiUsageHistory('openai', 'test', pages([{ data: [], has_more: true, next_page: 'same' }, { data: [], has_more: true, next_page: 'same' }], [])), /did not advance/);
});
