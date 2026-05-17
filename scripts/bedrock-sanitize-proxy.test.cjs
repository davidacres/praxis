const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeMetadataUserId,
  mapAnthropicToolChoice,
  translateAnthropicMessages,
  translateAnthropicRequestBody,
  buildAnthropicMessagePayload,
  buildAnthropicSseFrames,
  extractTextContent,
  extractToolResultText
} = require('./bedrock-sanitize-proxy.cjs');

test('sanitizeMetadataUserId rewrites structured metadata user ids', () => {
  const input = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'device-1',
        session_id: 'session-1'
      })
    }
  };

  const result = sanitizeMetadataUserId(input);

  assert.equal(result.changed, true);
  assert.equal(result.replacement, 'session-1');
  assert.equal(result.body.metadata.user_id, 'session-1');
});

test('mapAnthropicToolChoice maps supported tool choice variants', () => {
  assert.equal(mapAnthropicToolChoice('auto'), 'auto');
  assert.equal(mapAnthropicToolChoice({ type: 'auto' }), 'auto');
  assert.equal(mapAnthropicToolChoice({ type: 'any' }), 'required');
  assert.equal(mapAnthropicToolChoice({ type: 'none' }), 'none');
  assert.deepEqual(mapAnthropicToolChoice({ type: 'tool', name: 'lookup' }), {
    type: 'function',
    function: {
      name: 'lookup'
    }
  });
});

test('translateAnthropicMessages preserves plain text messages', () => {
  const translated = translateAnthropicMessages(
    [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'world' }
    ],
    [{ type: 'text', text: 'system line' }]
  );

  assert.deepEqual(translated, [
    { role: 'system', content: 'system line' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' }
  ]);
});

test('translateAnthropicMessages maps assistant tool_use blocks to OpenAI-style tool calls', () => {
  const translated = translateAnthropicMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { ticket: 'ABC-123' } }
      ]
    }
  ]);

  assert.deepEqual(translated, [
    {
      role: 'assistant',
      content: 'Working on it.',
      tool_calls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: JSON.stringify({ ticket: 'ABC-123' })
          }
        }
      ]
    }
  ]);
});

test('translateAnthropicMessages maps user tool results and appends remaining text', () => {
  const translated = translateAnthropicMessages([
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'done' }]
        },
        { type: 'text', text: 'continue' }
      ]
    }
  ]);

  assert.deepEqual(translated, [
    {
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'done'
    },
    {
      role: 'user',
      content: 'continue'
    }
  ]);
});

test('translateAnthropicMessages preserves user text order around tool results', () => {
  const translated = translateAnthropicMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'before ' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'result' }]
        },
        { type: 'text', text: 'after' }
      ]
    }
  ]);

  assert.deepEqual(translated, [
    {
      role: 'user',
      content: 'before '
    },
    {
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'result'
    },
    {
      role: 'user',
      content: 'after'
    }
  ]);
});

test('translateAnthropicRequestBody maps request settings and preserves model selection', () => {
  const translated = translateAnthropicRequestBody({
    model: 'zai.glm-5',
    stream: false,
    max_tokens: 321,
    temperature: 0.4,
    top_p: 0.9,
    stop_sequences: ['DONE'],
    metadata: {
      user_id: JSON.stringify({ session_id: 'session-2' })
    },
    system: [{ type: 'text', text: 'system text' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [
      {
        name: 'lookup',
        description: 'Lookup a ticket',
        input_schema: {
          type: 'object',
          properties: {
            ticket: { type: 'string' }
          },
          required: ['ticket']
        }
      }
    ],
    tool_choice: { type: 'tool', name: 'lookup' }
  });

  assert.equal(translated.stream, false);
  assert.equal(translated.modelId, 'zai.glm-5');
  assert.equal(translated.replacement, 'session-2');
  assert.deepEqual(translated.body, {
    messages: [
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'hello' }
    ],
    max_tokens: 321,
    temperature: 0.4,
    top_p: 0.9,
    stop: ['DONE'],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a ticket',
          parameters: {
            type: 'object',
            properties: {
              ticket: { type: 'string' }
            },
            required: ['ticket']
          }
        }
      }
    ],
    tool_choice: {
      type: 'function',
      function: {
        name: 'lookup'
      }
    }
  });
});

test('buildAnthropicMessagePayload maps GLM text and tool calls back to Anthropic blocks', () => {
  const payload = buildAnthropicMessagePayload({
    id: 'glm-1',
    model: 'zai.glm-5',
    usage: {
      prompt_tokens: 11,
      completion_tokens: 22
    },
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: 'Need a tool.',
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'lookup',
                arguments: JSON.stringify({ ticket: 'ABC-123' })
              }
            }
          ]
        }
      }
    ]
  });

  assert.deepEqual(payload, {
    id: 'glm-1',
    type: 'message',
    role: 'assistant',
    model: 'zai.glm-5',
    content: [
      { type: 'text', text: 'Need a tool.' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { ticket: 'ABC-123' } }
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 22
    }
  });
});

test('buildAnthropicSseFrames emits Anthropic SSE event sequence', () => {
  const frames = buildAnthropicSseFrames({
    id: 'glm-2',
    model: 'zai.glm-5',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5
    },
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: 'hello'
        }
      }
    ]
  }).map(frame => frame.toString('utf8'));

  assert.equal(frames.length, 6);
  assert.match(frames[0], /^event: message_start\n/);
  assert.match(frames[1], /^event: content_block_start\n/);
  assert.match(frames[2], /^event: content_block_delta\n/);
  assert.match(frames[3], /^event: content_block_stop\n/);
  assert.match(frames[4], /^event: message_delta\n/);
  assert.match(frames[5], /^event: message_stop\n/);
  assert.ok(frames.some(frame => frame.includes('hello')));
});

test('extractTextContent still only returns text blocks', () => {
  assert.equal(
    extractTextContent([
      { type: 'text', text: 'alpha' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
      { type: 'text', text: 'beta' }
    ]),
    'alphabeta'
  );
});

test('unsupported non-text tool results fail fast instead of being silently dropped', () => {
  assert.throws(
    () =>
      extractToolResultText([
        { type: 'text', text: 'json:' },
        { type: 'json', value: { ok: true } }
      ]),
    /tool_result contains unsupported content block type: json/
  );
});

test('unsupported multimodal message content fails fast during translation', () => {
  assert.throws(
    () =>
      translateAnthropicMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } }
          ]
        }
      ]),
    /message content contains unsupported block type: image/
  );
});