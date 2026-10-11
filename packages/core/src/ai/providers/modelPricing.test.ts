import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexContextLengths } from './modelCatalog';
import { canonicalCliModelId, copilotModelMetadata, cursorModelMetadata, publishedCliModelMetadata, readNativeCliModelMetadata } from './cliModelMetadata';

test('native catalogs preserve context sizes and billing units', () => {
  const copilot = copilotModelMetadata({ models: [
    { id: 'sonnet', capabilities: { limits: { max_context_window_tokens: 1000000 } }, billing: { tokenPrices: { inputPrice: 2, outputPrice: 10, batchSize: 10000 } } },
    { id: 'auto', billing: { discountPercent: 10 } },
    { id: 'invalid', capabilities: { limits: { max_context_window_tokens: -1 } }, billing: { tokenPrices: { inputPrice: -1, outputPrice: 2, batchSize: 0 } } }
  ] });
  assert.deepEqual(copilot.get('sonnet'), { contextLength: 1000000, pricingLabel: '200 / 1000 credits/1M' });
  assert.deepEqual(copilot.get('auto'), { contextLabel: 'Model dependent', pricingLabel: 'Routed rate −10%' });
  assert.deepEqual(copilot.get('invalid'), {});
  const cursor = cursorModelMetadata({ models: [
    { name: 'gemini-3.8-flash', contextTokenLimit: 1000000, tooltipData: { markdownContent: '200k context window' } },
    { name: 'claude-opus-5-5-medium', tooltipData: { markdownContent: '300k context window' }, idAliases: ['opus'] }
  ] });
  assert.equal(cursor.get('gemini-3.8-flash')?.contextLength, 1000000, 'structured limits take precedence over old tooltips');
  assert.equal(cursor.get('claude-opus-5.5')?.contextLength, 300000);
  assert.equal(cursor.get('opus')?.contextLength, 300000);
  assert.equal(canonicalCliModelId('claude-opus-5-5[context=300k,effort=high]'), 'claude-opus-5.5');
  assert.deepEqual(publishedCliModelMetadata('claude-code-cli', { value: 'sonnet', name: 'Sonnet 5.5' }), { contextLength: 1000000, pricingLabel: 'API base $2 / $10 /1M' });
  assert.equal(publishedCliModelMetadata('cursor-cli', { value: 'grok-4.7[context=500k,fast=true]', name: 'Grok 4.7' }).pricingLabel, '$6 / $18 /1M');
  assert.deepEqual(publishedCliModelMetadata('claude-code-cli', { value: 'constructor', name: 'constructor' }), {});
});

test('native Claude and Copilot probes request metadata without sending a prompt', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'praxis-native-catalog-'));
  const fixture = join(folder, 'native.cjs');
  const requests = join(folder, 'requests.jsonl');
  await writeFile(fixture, `
const fs = require('node:fs');
const requests = ${JSON.stringify(requests)};
if (process.argv.includes('--server')) {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\\d+)/)[1]);
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    fs.appendFileSync(requests, JSON.stringify(request) + '\\n');
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { models: [{ id: 'model-é', capabilities: { limits: { max_context_window_tokens: 500000 } } }] } }));
    const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]);
    process.stdout.write(frame.subarray(0, 25));
    setTimeout(() => process.stdout.write(frame.subarray(25)), 10);
  });
} else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(requests, line + '\\n');
    let response = {};
    if (request.request.subtype === 'initialize') response = { models: [{ value: 'opus' }, { value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'haiku' }] };
    if (request.request.subtype === 'get_context_usage') response = { rawMaxTokens: 1000000 };
    const envelope = request.request.subtype === 'set_model' && request.request.model === 'fable'
      ? { subtype: 'error', request_id: request.request_id, error: 'Usage credits required' }
      : { subtype: 'success', request_id: request.request_id, response };
    process.stdout.write(JSON.stringify({ type: 'control_response', response: envelope }) + '\\n');
  });
}
`);
  try {
    const copilot = await readNativeCliModelMetadata('copilot-cli', process.execPath, [fixture]);
    assert.equal(copilot.get('model-é')?.contextLength, 500000);
    const claude = await readNativeCliModelMetadata('claude-code-cli', process.execPath, [fixture]);
    assert.equal(claude.get('opus')?.contextLength, 1000000);
    assert.equal(claude.get('haiku')?.contextLength, 1000000);
    assert.equal(claude.get('fable')?.contextLength, 1000000, 'one entitlement failure keeps the resolved model metadata and does not abort other models');
    const rows = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows[0].method, 'models.list');
    assert.ok(rows.slice(1).every(row => row.type === 'control_request' && ['initialize', 'set_model', 'get_context_usage'].includes(row.request.subtype)));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
import { estimateCostUsd, estimateTurnCost, getKnownContextLength, getModelPricing } from './modelPricing';

test('CLI metadata does not substitute API prices or context guesses', () => {
  for (const provider of ['codex-cli', 'claude-code-cli', 'copilot-cli', 'antigravity-cli', 'cursor-cli'] as const) {
    assert.equal(getModelPricing(provider, 'claude-sonnet-4-6'), undefined);
    assert.equal(getKnownContextLength('claude-sonnet-4-6', provider), undefined);
  }
  assert.equal(getKnownContextLength('gpt-5.6-sol[context=272k,reasoning=medium]', 'cursor-cli'), 272000);
  assert.equal(getKnownContextLength('claude-opus-5[thinking=true,context=300k,effort=high]', 'cursor-cli'), 300000);
  assert.equal(getKnownContextLength('unknown[context=0k]', 'cursor-cli'), undefined);
  assert.deepEqual(getModelPricing('custom:example-cli', 'gpt-4o'), { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 });
});

test('Codex cache uses the default context and tolerates missing or invalid metadata', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'praxis-codex-models-'));
  try {
    assert.equal((await readCodexContextLengths(folder)).size, 0);
    await writeFile(join(folder, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6.1-sol', context_window: 272000, max_context_window: 872000 },
      { slug: 'bad', context_window: -1 }, { slug: 'string', context_window: '272000' }, null
    ] }));
    assert.deepEqual([...await readCodexContextLengths(folder)], [['gpt-6.1-sol', 272000]]);
    await writeFile(join(folder, 'models_cache.json'), 'broken');
    assert.equal((await readCodexContextLengths(folder)).size, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a known Z.ai model prices input and output tokens independently', () => {
  const cost = estimateCostUsd('z-ai', 'glm-5.3', { inputTokens: 500_000, outputTokens: 250_000 });
  assert.equal(cost?.currency, 'USD');
  // $1.40/M input, $4.40/M output.
  assert.ok(cost && Math.abs(cost.amount - (0.7 + 1.1)) < 1e-9, `unexpected cost ${cost?.amount}`);
});

test('model id matching ignores case and surrounding whitespace', () => {
  const cost = estimateCostUsd('z-ai', '  GLM-5.3  ', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.ok(cost && Math.abs(cost.amount - 1.4) < 1e-9);
});

test('a free-tier model prices at zero rather than being unpriced', () => {
  const cost = estimateCostUsd('z-ai', 'glm-4.5-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.deepEqual(cost, { amount: 0, currency: 'USD' });
});

test('an unknown model for a priced provider returns undefined, not zero', () => {
  assert.equal(estimateCostUsd('z-ai', 'glm-99-nonexistent', { inputTokens: 1000 }), undefined);
});

test('a provider with no maintained price table in estimateCostUsd returns undefined', () => {
  assert.equal(estimateCostUsd('openai', 'gpt-4o-mini', { inputTokens: 1000, outputTokens: 1000 }), undefined);
});

test('estimateTurnCost prices OpenAI, Anthropic, and other supported providers', () => {
  const cost = estimateTurnCost('openai', 'gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(cost && Math.abs(cost.amount - 0.75) < 1e-9);
});

test('a missing provider or model returns undefined', () => {
  assert.equal(estimateCostUsd(undefined, 'glm-5.3', { inputTokens: 1000 }), undefined);
  assert.equal(estimateCostUsd('z-ai', undefined, { inputTokens: 1000 }), undefined);
});

test('getModelPricing provides rates for all major providers and gateway models', () => {
  // OpenAI
  assert.deepEqual(getModelPricing('openai', 'gpt-4o'), { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 });
  assert.deepEqual(getModelPricing('openai', 'gpt-4o-mini'), { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 });

  // Anthropic
  assert.deepEqual(getModelPricing('anthropic', 'claude-3-5-sonnet-20241022'), { inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
  assert.deepEqual(getModelPricing('anthropic', 'claude-3-5-haiku-20241022'), { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 });
  assert.deepEqual(getModelPricing('anthropic', 'claude-haiku-5-5'), { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 });
  assert.equal(getModelPricing('claude-code-cli', 'haiku'), undefined);

  // Gemini
  assert.deepEqual(getModelPricing('gemini', 'gemini-2.5-pro'), { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 });
  assert.deepEqual(getModelPricing('gemini', 'gemini-2.5-flash'), { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 });

  // Z.ai
  assert.deepEqual(getModelPricing('z-ai', 'glm-5.3'), { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4 });

  // Vercel Gateway prefixed models
  assert.deepEqual(getModelPricing('vercel-gateway', 'anthropic/claude-3.5-sonnet'), { inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
  assert.deepEqual(getModelPricing('vercel-gateway', 'openai/gpt-4o'), { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 });
});

test('getKnownContextLength provides context limits across all providers and models', () => {
  assert.equal(getKnownContextLength('gpt-4o', 'openai'), 128000);
  assert.equal(getKnownContextLength('o1', 'openai'), 200000);
  assert.equal(getKnownContextLength('claude-3-5-sonnet-20241022', 'anthropic'), 200000);
  assert.equal(getKnownContextLength('claude-haiku-5-5', 'anthropic'), 1000000);
  assert.equal(getKnownContextLength('haiku', 'claude-code-cli'), undefined);
  assert.equal(getKnownContextLength('gemini-2.5-pro', 'gemini'), 2097152);
  assert.equal(getKnownContextLength('gemini-2.5-flash', 'gemini'), 1048576);
  assert.equal(getKnownContextLength('glm-5.3', 'z-ai'), 128000);
  assert.equal(getKnownContextLength('anthropic/claude-3-7-sonnet', 'vercel-gateway'), 200000);
  assert.equal(getKnownContextLength('mock/model'), undefined);
});
