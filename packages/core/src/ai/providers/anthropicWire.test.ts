import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicRequest, consumeAnthropicStream } from './anthropicWire';
import type { StreamChatEvent, WireMessage } from '../gateway/wire';

const baseMessages: WireMessage[] = [
  { role: 'system', content: 'You are a helpful coding assistant.' },
  { role: 'user', content: 'Hello!' }
];

test('buildAnthropicRequest omits thinking when reasoningEffort is unset or off', () => {
  const unset = buildAnthropicRequest({ modelId: 'claude-opus-4-6', messages: baseMessages, temperature: 0.4 });
  assert.equal(unset.thinking, undefined);
  assert.equal(unset.temperature, 0.4);

  const off = buildAnthropicRequest({ modelId: 'claude-opus-4-6', messages: baseMessages, reasoningEffort: 'off' });
  assert.equal(off.thinking, undefined);
});

test('buildAnthropicRequest uses adaptive thinking for Claude 4.6+ and drops temperature', () => {
  const result = buildAnthropicRequest({
    modelId: 'claude-opus-4-6',
    messages: baseMessages,
    temperature: 0.4,
    reasoningEffort: 'high'
  });

  // Claude 4.6 accepts both modes; adaptive is recommended, and depth is
  // steered by output_config.effort rather than a token budget.
  assert.deepEqual(result.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(result.output_config, { effort: 'high' });
  // Thinking is incompatible with a custom temperature — Anthropic rejects it.
  assert.equal(result.temperature, undefined);
  // No budget means no max_tokens floor to clear.
  assert.equal(result.max_tokens, 8192);
});

test('buildAnthropicRequest sends adaptive thinking to Claude 5.x, which rejects the enabled shape', () => {
  for (const modelId of ['claude-sonnet-5', 'claude-fable-5.1', 'claude-opus-5.5']) {
    const result = buildAnthropicRequest({ modelId, messages: baseMessages, reasoningEffort: 'medium' });
    assert.deepEqual(result.thinking, { type: 'adaptive', display: 'summarized' }, modelId);
    assert.deepEqual(result.output_config, { effort: 'medium' }, modelId);
    assert.equal('budget_tokens' in (result.thinking as object), false, modelId);
  }
});

test('buildAnthropicRequest keeps extended thinking for Claude 4.5 and earlier, which reject adaptive', () => {
  for (const modelId of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-7-sonnet']) {
    const result = buildAnthropicRequest({ modelId, messages: baseMessages, maxTokens: 512, reasoningEffort: 'low' });
    assert.deepEqual(result.thinking, { type: 'enabled', budget_tokens: 1024 }, modelId);
    assert.equal('output_config' in result, false, modelId);
    // Extended thinking requires max_tokens to exceed budget_tokens.
    assert.ok((result.max_tokens as number) > 1024, modelId);
  }
});

test('buildAnthropicRequest sends no thinking parameter for an unrecognizable Claude alias', () => {
  // Guessing a mode here is a 400 error either way; omitting the parameter is
  // always accepted, since 5.x models think by default.
  const result = buildAnthropicRequest({
    modelId: 'claude-internal-preview',
    messages: baseMessages,
    reasoningEffort: 'high'
  });
  assert.equal(result.thinking, undefined);
  assert.equal('output_config' in result, false);
});

test('consumeAnthropicStream streams thinking deltas ahead of text deltas', async () => {
  async function* sseLines(): AsyncGenerator<string> {
    yield 'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}';
    yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering the request..."}}';
    yield 'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}';
    yield 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is the answer."}}';
    yield 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}';
  }

  const events: StreamChatEvent[] = [];
  for await (const evt of consumeAnthropicStream(sseLines())) {
    events.push(evt);
  }

  assert.deepEqual(events[0], { type: 'thought_delta', text: 'Considering the request...' });
  assert.deepEqual(events[1], { type: 'text_delta', text: 'Here is the answer.' });
  assert.deepEqual(events[2], {
    type: 'done',
    result: { text: 'Here is the answer.', toolCalls: [], finishReason: 'end_turn' }
  });
});
