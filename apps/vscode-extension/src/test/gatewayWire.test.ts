import * as assert from 'assert';
import {
  assistantMessageWithToolCalls,
  buildChatRequest,
  collectChatCompletion,
  normalizeInboundModelId,
  sanitizeToolCallId,
  toWireModelId,
  toolResultMessages
} from '@praxis/core';

suite('gateway wire', () => {
  test('normalizeInboundModelId prefixes Vercel/', () => {
    assert.strictEqual(normalizeInboundModelId('anthropic/claude-sonnet-4.6'), 'Vercel/anthropic/claude-sonnet-4.6');
    assert.strictEqual(
      normalizeInboundModelId('Vercel/anthropic/claude-sonnet-4.6'),
      'Vercel/anthropic/claude-sonnet-4.6'
    );
  });

  test('toWireModelId strips Vercel/ prefix', () => {
    assert.strictEqual(toWireModelId('Vercel/anthropic/claude-sonnet-4.6'), 'anthropic/claude-sonnet-4.6');
    assert.strictEqual(toWireModelId('anthropic/claude-sonnet-4.6'), 'anthropic/claude-sonnet-4.6');
  });

  test('buildChatRequest includes OpenAI tools and stream options', () => {
    const body = buildChatRequest({
      modelId: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      ]
    });

    assert.strictEqual(body.model, 'anthropic/claude-sonnet-4.6');
    assert.strictEqual(body.stream, true);
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
    assert.ok(Array.isArray(body.tools));
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    assert.strictEqual(tools[0]?.type, 'function');
    assert.strictEqual(tools[0]?.function.name, 'read_file');
    assert.deepStrictEqual(body.providerOptions, { gateway: { caching: 'auto' } });
  });

  test('assistant and tool result messages use OpenAI tool encoding', () => {
    const assistant = assistantMessageWithToolCalls('checking', [
      { id: 'call/1', name: 'read_file', arguments: { path: 'a.ts' } }
    ]);
    assert.strictEqual(assistant.role, 'assistant');
    assert.strictEqual(assistant.tool_calls?.[0]?.id, sanitizeToolCallId('call/1'));
    assert.strictEqual(assistant.tool_calls?.[0]?.function.name, 'read_file');

    const results = toolResultMessages([{ callId: 'call/1', content: 'ok' }]);
    assert.strictEqual(results[0]?.role, 'tool');
    assert.strictEqual(results[0]?.tool_call_id, sanitizeToolCallId('call/1'));
    assert.strictEqual(results[0]?.content, 'ok');
  });

  test('collectChatCompletion parses OpenAI SSE text and tool calls', async () => {
    async function* lines(): AsyncIterable<string> {
      yield 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_dir","arguments":"{\\"path\\":\\".\\"}"}}]}}]}';
      yield 'data: [DONE]';
    }

    const result = await collectChatCompletion(lines());
    assert.strictEqual(result.text, 'Hello');
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0]?.name, 'list_dir');
    assert.deepStrictEqual(result.toolCalls[0]?.arguments, { path: '.' });
  });
});
