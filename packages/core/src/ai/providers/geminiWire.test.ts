import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiRequest,
  consumeGeminiStream,
  toGeminiContents,
  toGeminiTools
} from './geminiWire';
import type { GatewayToolDefinition, WireMessage } from '../gateway/wire';

test('toGeminiContents extracts leading system message into systemInstruction', () => {
  const messages: WireMessage[] = [
    { role: 'system', content: 'You are a helpful coding assistant.' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' }
  ];

  const result = toGeminiContents(messages);

  assert.deepEqual(result.systemInstruction, {
    parts: [{ text: 'You are a helpful coding assistant.' }]
  });
  assert.equal(result.contents.length, 2);
  assert.deepEqual(result.contents[0], {
    role: 'user',
    parts: [{ text: 'Hello!' }]
  });
  assert.deepEqual(result.contents[1], {
    role: 'model',
    parts: [{ text: 'Hi there!' }]
  });
});

test('toGeminiContents maps assistant tool calls and user tool responses', () => {
  const messages: WireMessage[] = [
    { role: 'user', content: 'Read file.txt' },
    {
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'file.txt' }) }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'file contents here'
    }
  ];

  const result = toGeminiContents(messages);

  assert.equal(result.contents.length, 3);
  assert.deepEqual(result.contents[1], {
    role: 'model',
    parts: [
      { text: 'Let me check.' },
      { functionCall: { name: 'read_file', args: { path: 'file.txt' } } }
    ]
  });
  assert.deepEqual(result.contents[2], {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'read_file',
          response: { output: 'file contents here' }
        }
      }
    ]
  });
});

test('toGeminiContents coalesces consecutive tool result messages into a single user turn', () => {
  const messages: WireMessage[] = [
    {
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'c1', content: 'res1' },
    { role: 'tool', tool_call_id: 'c2', content: '{"status":"ok"}' }
  ];

  const result = toGeminiContents(messages);

  assert.equal(result.contents.length, 2);
  assert.equal(result.contents[1].role, 'user');
  assert.equal(result.contents[1].parts.length, 2);
  assert.deepEqual(result.contents[1].parts[0], {
    functionResponse: { name: 'tool_a', response: { output: 'res1' } }
  });
  assert.deepEqual(result.contents[1].parts[1], {
    functionResponse: { name: 'tool_b', response: { status: 'ok' } }
  });
});

test('toGeminiTools maps tool definitions to functionDeclarations', () => {
  const tools: GatewayToolDefinition[] = [
    {
      name: 'search_code',
      description: 'Search repository',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  ];

  const result = toGeminiTools(tools);

  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].functionDeclarations.length, 1);
  assert.equal(result[0].functionDeclarations[0].name, 'search_code');
  assert.equal(result[0].functionDeclarations[0].description, 'Search repository');
});

test('buildGeminiRequest sets model, contents, tools, and generationConfig', () => {
  const req = buildGeminiRequest({
    modelId: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ name: 'dummy' }],
    temperature: 0.5,
    maxTokens: 4096
  });

  assert.equal(req.model, 'gemini-2.5-pro');
  assert.equal(req.contents.length, 1);
  assert.ok(req.tools);
  assert.deepEqual(req.generationConfig, {
    temperature: 0.5,
    maxOutputTokens: 4096
  });
});

test('consumeGeminiStream streams text deltas and thinking deltas', async () => {
  async function* sseLines(): AsyncGenerator<string> {
    yield 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking about the answer..."}]}}]}';
    yield 'data: {"candidates":[{"content":{"parts":[{"text":"Here is "}]}}]}';
    yield 'data: {"candidates":[{"content":{"parts":[{"text":"the answer."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":25,"totalTokenCount":40}}';
  }

  const events: Array<import('../gateway/wire').StreamChatEvent> = [];
  for await (const evt of consumeGeminiStream(sseLines())) {
    events.push(evt);
  }

  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { type: 'thought_delta', text: 'Thinking about the answer...' });
  assert.deepEqual(events[1], { type: 'text_delta', text: 'Here is ' });
  assert.deepEqual(events[2], { type: 'text_delta', text: 'the answer.' });
  assert.deepEqual(events[3], {
    type: 'done',
    result: {
      text: 'Here is the answer.',
      toolCalls: [],
      finishReason: 'STOP',
      usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 }
    }
  });
});

test('consumeGeminiStream parses functionCall in candidates', async () => {
  async function* sseLines(): AsyncGenerator<string> {
    yield 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_files","args":{"dir":"src"}}}]}}]}';
  }

  const events: Array<import('../gateway/wire').StreamChatEvent> = [];
  for await (const evt of consumeGeminiStream(sseLines())) {
    events.push(evt);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'done');
  if (events[0].type === 'done') {
    assert.equal(events[0].result.toolCalls.length, 1);
    assert.equal(events[0].result.toolCalls[0].name, 'list_files');
    assert.deepEqual(events[0].result.toolCalls[0].arguments, { dir: 'src' });
  }
});

