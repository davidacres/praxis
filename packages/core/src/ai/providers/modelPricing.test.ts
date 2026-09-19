import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd, getKnownContextLength, getModelPricing } from './modelPricing';

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

test('a provider with no maintained price table returns undefined', () => {
  assert.equal(estimateCostUsd('openai', 'gpt-4o-mini', { inputTokens: 1000, outputTokens: 1000 }), undefined);
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
  assert.equal(getKnownContextLength('gemini-2.5-pro', 'gemini'), 2097152);
  assert.equal(getKnownContextLength('gemini-2.5-flash', 'gemini'), 1048576);
  assert.equal(getKnownContextLength('glm-5.3', 'z-ai'), 128000);
  assert.equal(getKnownContextLength('anthropic/claude-3-7-sonnet', 'vercel-gateway'), 200000);
  assert.equal(getKnownContextLength('mock/model'), undefined);
});
