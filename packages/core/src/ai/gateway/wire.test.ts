import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistoryForReplay, consumeChatStream, type WireMessage } from './wire';

test('compactHistoryForReplay strips tool round-trips, keeps the text exchange', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'open example.com and summarise it' },
    {
      role: 'assistant',
      content: 'Let me look.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_navigate', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(12000) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'browser_read', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c2', content: 'another 8000 chars of page text' },
    { role: 'assistant', content: 'It is a placeholder page owned by IANA.' },
    { role: 'user', content: 'who runs it?' }
  ];

  const compacted = compactHistoryForReplay(history);

  assert.deepEqual(compacted, [
    { role: 'user', content: 'open example.com and summarise it' },
    { role: 'assistant', content: 'Let me look.' },
    { role: 'assistant', content: 'It is a placeholder page owned by IANA.' },
    { role: 'user', content: 'who runs it?' }
  ]);
  // No tool traffic survives.
  assert.equal(compacted.some(m => m.role === 'tool' || m.tool_calls), false);
});

test('compactHistoryForReplay is a no-op for a plain chat history', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  assert.deepEqual(compactHistoryForReplay(history), history);
});

/** Feeds SSE `data:` lines to the parser and returns the final `done` result. */
async function runStream(events: unknown[]): Promise<import('./wire').ChatCompletionResult> {
  async function* lines(): AsyncGenerator<string> {
    for (const event of events) yield `data: ${JSON.stringify(event)}`;
    yield 'data: [DONE]';
  }
  let result: import('./wire').ChatCompletionResult | undefined;
  for await (const event of consumeChatStream(lines())) {
    if (event.type === 'done') result = event.result;
  }
  assert.ok(result, 'stream should end with a done event');
  return result;
}

test('reads token usage from an OpenAI-compatible stream', async () => {
  const result = await runStream([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    // The usage chunk carries no choices at all — it must not be discarded
    // along with them.
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 } }
  ]);

  assert.equal(result.text, 'hi');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 34, totalTokens: 154 });
});

test('reads token usage across an Anthropic stream, input first then output', async () => {
  const result = await runStream([
    { type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 0 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 57 } },
    { type: 'message_stop' }
  ]);

  assert.equal(result.text, 'ok');
  assert.equal(result.finishReason, 'end_turn');
  // Output arrives in a later event than input; neither may clobber the other,
  // and the total is derived when the provider does not send one.
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 57, totalTokens: 957 });
});

test('a provider that reports no usage yields none, rather than zeroes', async () => {
  const result = await runStream([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }
  ]);

  assert.equal(result.usage, undefined);
});
