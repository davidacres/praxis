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

test('buildAnthropicRequest enables thinking and drops temperature for a set effort level', () => {
  const result = buildAnthropicRequest({
    modelId: 'claude-opus-4-6',
    messages: baseMessages,
    temperature: 0.4,
    reasoningEffort: 'high'
  });

  assert.deepEqual(result.thinking, { type: 'enabled', budget_tokens: 8192 });
  // Thinking is incompatible with a custom temperature — Anthropic rejects both.
  assert.equal(result.temperature, undefined);
  // max_tokens must exceed budget_tokens.
  assert.ok((result.max_tokens as number) > 8192);
});

test('buildAnthropicRequest raises a low default max_tokens to fit the thinking budget', () => {
  const result = buildAnthropicRequest({
    modelId: 'claude-opus-4-6',
    messages: baseMessages,
    maxTokens: 512,
    reasoningEffort: 'low'
  });

  assert.deepEqual(result.thinking, { type: 'enabled', budget_tokens: 1024 });
  assert.ok((result.max_tokens as number) > 1024);
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
