import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicThinkingBudget, detectReasoningFamily, geminiThinkingBudget, supportsReasoningEffort } from './reasoningSupport';

test('detects reasoning family from the model id regardless of which provider is routing it', () => {
  // The registry's actual default models — see PROVIDER_DESCRIPTORS.
  assert.equal(detectReasoningFamily('anthropic/claude-sonnet-4.6'), 'anthropic'); // vercel-gateway's default
  assert.equal(detectReasoningFamily('claude-sonnet-4-6'), 'anthropic'); // anthropic's own default
  assert.equal(detectReasoningFamily('gemini-2.5-flash'), 'gemini'); // gemini's default
  assert.equal(detectReasoningFamily('gpt-4o-mini'), undefined); // openai's default — not a reasoning model
  assert.equal(detectReasoningFamily('glm-5.3'), undefined); // z-ai's default
  assert.equal(detectReasoningFamily('o3'), 'openai');
  assert.equal(detectReasoningFamily('gpt-5.1'), 'openai');
  assert.equal(detectReasoningFamily(undefined), undefined);
});

test('supportsReasoningEffort exposes every selectable provider model', () => {
  assert.equal(supportsReasoningEffort('vercel-gateway', 'anthropic/claude-sonnet-4.6'), true);
  assert.equal(supportsReasoningEffort('anthropic', 'claude-sonnet-4-6'), true);
  assert.equal(supportsReasoningEffort('gemini', 'gemini-2.5-flash'), true);
  assert.equal(supportsReasoningEffort('openai', 'gpt-4o-mini'), true);
  assert.equal(supportsReasoningEffort('z-ai', 'glm-5.3'), true);
  assert.equal(supportsReasoningEffort('codex-cli', 'gpt-5.6-codex'), true);
  assert.equal(supportsReasoningEffort('openai', undefined), true);
  assert.equal(supportsReasoningEffort(undefined, 'gpt-5.1'), false);
});

test('thinking budgets scale with level and are undefined for off', () => {
  assert.equal(anthropicThinkingBudget('off'), undefined);
  assert.equal(anthropicThinkingBudget(undefined), undefined);
  assert.equal(anthropicThinkingBudget('low'), 1024);
  assert.equal(anthropicThinkingBudget('medium'), 4096);
  assert.equal(anthropicThinkingBudget('high'), 8192);
  assert.equal(geminiThinkingBudget('off'), undefined);
  assert.equal(geminiThinkingBudget('high'), 8192);
});
