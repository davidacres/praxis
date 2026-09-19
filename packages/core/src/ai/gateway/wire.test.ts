import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, compactHistoryForReplay, consumeChatStream, trimToolOutputToBudget, type WireMessage } from './wire';

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

test('reads token usage from choice-level usage or camelCase format', async () => {
  const result = await runStream([
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop', usage: { promptTokens: 250, completionTokens: 40, totalTokens: 290 } }] }
  ]);

  assert.equal(result.text, 'hello');
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 40, totalTokens: 290 });
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

test('trimToolOutputToBudget leaves a conversation inside budget untouched', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'do a thing' },
    { role: 'tool', tool_call_id: 'c1', content: 'small result' }
  ];

  const result = trimToolOutputToBudget(history, 10_000);

  assert.equal(result.trimmed, 0);
  assert.deepEqual(result.history, history);
});

test('trimToolOutputToBudget drops the oldest tool output first, keeping the newest', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'tool', tool_call_id: 'c1', content: 'A'.repeat(5000) },
    { role: 'tool', tool_call_id: 'c2', content: 'B'.repeat(5000) },
    { role: 'tool', tool_call_id: 'c3', content: 'C'.repeat(5000) }
  ];

  const result = trimToolOutputToBudget(history, 8000);

  // Oldest goes first; the most recent result — what the next turn reasons
  // about — survives.
  assert.ok(result.trimmed >= 1);
  assert.ok(!result.history[1].content?.startsWith('A'), 'the oldest result is elided');
  assert.equal(result.history[3].content, 'C'.repeat(5000), 'the newest result is kept');
  // The tool message itself must remain: an assistant tool_call without its
  // matching result is a protocol error.
  assert.equal(result.history.length, history.length);
  assert.equal(result.history[1].role, 'tool');
  assert.equal(result.history[1].tool_call_id, 'c1');
});

test('trimToolOutputToBudget never touches user or assistant turns', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'X'.repeat(9000) },
    { role: 'assistant', content: 'Y'.repeat(9000) }
  ];

  const result = trimToolOutputToBudget(history, 100);

  // Nothing can be freed without losing the thread of the work, so nothing is.
  assert.equal(result.trimmed, 0);
  assert.deepEqual(result.history, history);
});

test('compactHistoryForReplay keeps user image attachments riding along', () => {
  const history: WireMessage[] = [
    { role: 'user', content: 'first turn', images: [{ mimeType: 'image/png', dataBase64: 'aGk=' }] },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'second turn', images: [{ mimeType: 'image/jpeg', dataBase64: 'aGk=' }] }
  ];

  const replay = compactHistoryForReplay(history);

  assert.deepEqual(replay, history, 'user turns keep their images across replay');
});

test('buildChatRequest serialises user images as OpenAI image_url content parts', () => {
  const body = buildChatRequest({
    modelId: 'mock/model',
    messages: [
      { role: 'user', content: 'What is in this screenshot?', images: [{ mimeType: 'image/png', dataBase64: 'aGk=' }] }
    ],
    stream: false
  }) as { messages: Array<{ role: string; content: unknown }> };

  const [message] = body.messages;
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [
    { type: 'text', text: 'What is in this screenshot?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }
  ]);
});

test('buildChatRequest sends an image-only user turn without a text part', () => {
  const body = buildChatRequest({
    modelId: 'mock/model',
    messages: [{ role: 'user', images: [{ mimeType: 'image/webp', dataBase64: 'aGk=' }] }],
    stream: false
  }) as { messages: Array<{ role: string; content: unknown }> };

  assert.deepEqual((body.messages[0] as { content: unknown }).content, [
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,aGk=' } }
  ]);
});
