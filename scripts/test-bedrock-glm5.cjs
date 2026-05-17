const {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand
} = require('@aws-sdk/client-bedrock-runtime');

const CLAUDE_LIKE_BODY = {
  messages: [
    {
      role: 'user',
      content: '<available-deferred-tools>\nAskUserQuestion\nCronCreate\nCronDelete\nCronList\nEnterPlanMode\nEnterWorktree\nExitPlanMode\nExitWorktree\nNotebookEdit\nScheduleWakeup\nSendMessage\nTaskOutput\nTaskStop\nTeamCreate\nTeamDelete\nTodoWrite\nWebFetch\n</available-deferred-tools>'
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Reply with exactly: CLAUDE_BODY_OK'
        }
      ]
    }
  ],
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.104.583; cc_entrypoint=sdk-cli;'
    },
    {
      type: 'text',
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK."
    }
  ],
  tools: [],
  max_tokens: 128,
  metadata: {
    user_id: '{"session_id":"debug-session"}'
  },
  anthropic_beta: ['interleaved-thinking-2025-05-14'],
  anthropic_version: 'bedrock-2023-05-31'
};

const CLAUDE_LIKE_HEADERS = {
  'anthropic-beta': 'claude-code-20250219',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  'x-app': 'cli',
  'x-claude-code-session-id': '0d0afa64-af41-428c-b976-8b2ad453d8b7',
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Windows',
  'x-stainless-package-version': '0.81.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-timeout': '600'
};

function createClient(region, extraHeaders) {
  const client = new BedrockRuntimeClient({ region });

  if (extraHeaders) {
    client.middlewareStack.add(
      next => async args => {
        for (const [key, value] of Object.entries(extraHeaders)) {
          args.request.headers[key] = value;
        }

        return next(args);
      },
      {
        step: 'build',
        name: 'debugExtraHeadersMiddleware'
      }
    );
  }

  return client;
}

async function sendInvokeStream(client, modelId, body) {
  return client.send(
    new InvokeModelWithResponseStreamCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body)
    })
  );
}

function extractText(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap(block => {
      if (typeof block?.text === 'string') {
        return [block.text];
      }

      if (typeof block?.reasoningText?.text === 'string') {
        return [block.reasoningText.text];
      }

      return [];
    })
    .join('\n')
    .trim();
}

async function main() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const mode = process.argv[2] || 'converse';
  const modelId = process.argv[3] || 'zai.glm-5';
  const prompt = process.argv.slice(4).join(' ').trim() || 'Reply with exactly: GLM5_OK';

  const client = createClient(region);

  console.log(JSON.stringify({ region, mode, modelId, prompt }, null, 2));

  if (mode === 'converse') {
    const command = new ConverseCommand({
      modelId,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }]
        }
      ],
      inferenceConfig: {
        maxTokens: 128,
        temperature: 0
      }
    });

    const response = await client.send(command);
    const outputMessage = response.output?.message;
    const text = extractText(outputMessage?.content);

    console.log(
      JSON.stringify(
        {
          stopReason: response.stopReason,
          usage: response.usage || null,
          metrics: response.metrics || null
        },
        null,
        2
      )
    );

    if (text) {
      console.log('MODEL_TEXT_START');
      console.log(text);
      console.log('MODEL_TEXT_END');
      return;
    }

    console.log('MODEL_RAW_START');
    console.log(JSON.stringify(response.output || null, null, 2));
    console.log('MODEL_RAW_END');
    return;
  }

  const invokeBody = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    max_tokens: 128,
    temperature: 0
  });

  const anthropicInvokeBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 128,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          }
        ]
      }
    ]
  });

  const toolInvokeBody = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: 'Use the get_status tool and pass {"ticket":"ABC-123"}. Do not answer directly.'
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_status',
          description: 'Get the status for a ticket.',
          parameters: {
            type: 'object',
            properties: {
              ticket: {
                type: 'string'
              }
            },
            required: ['ticket']
          }
        }
      }
    ],
    tool_choice: 'auto',
    max_tokens: 128,
    temperature: 0
  });

  if (mode === 'invoke') {
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: invokeBody
      })
    );

    const bodyText = new TextDecoder().decode(response.body);
    console.log('MODEL_TEXT_START');
    console.log(bodyText);
    console.log('MODEL_TEXT_END');
    return;
  }

  if (mode === 'invoke-anthropic') {
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: anthropicInvokeBody
      })
    );

    const bodyText = new TextDecoder().decode(response.body);
    console.log('MODEL_TEXT_START');
    console.log(bodyText);
    console.log('MODEL_TEXT_END');
    return;
  }

  if (mode === 'invoke-stream') {
    const response = await client.send(
      new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: invokeBody
      })
    );

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-anthropic') {
    const response = await client.send(
      new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: anthropicInvokeBody
      })
    );

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-body') {
    const response = await sendInvokeStream(client, modelId, CLAUDE_LIKE_BODY);

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-body-no-metadata') {
    const { metadata, ...bodyWithoutMetadata } = CLAUDE_LIKE_BODY;
    const response = await sendInvokeStream(client, modelId, bodyWithoutMetadata);

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-body-metadata-simple') {
    const response = await sendInvokeStream(client, modelId, {
      ...CLAUDE_LIKE_BODY,
      metadata: {
        user_id: 'debug-session'
      }
    });

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-body-no-system') {
    const { system, ...bodyWithoutSystem } = CLAUDE_LIKE_BODY;
    const response = await sendInvokeStream(client, modelId, bodyWithoutSystem);

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-body-no-beta') {
    const { anthropic_beta, ...bodyWithoutBeta } = CLAUDE_LIKE_BODY;
    const response = await sendInvokeStream(client, modelId, bodyWithoutBeta);

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-headers') {
    const clientWithHeaders = createClient(region, CLAUDE_LIKE_HEADERS);
    const response = await clientWithHeaders.send(
      new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: anthropicInvokeBody
      })
    );

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-stream-claude-full') {
    const clientWithHeaders = createClient(region, CLAUDE_LIKE_HEADERS);
    const response = await sendInvokeStream(clientWithHeaders, modelId, CLAUDE_LIKE_BODY);

    console.log('MODEL_STREAM_START');
    for await (const chunk of response.body) {
      console.log(JSON.stringify(chunk));
    }
    console.log('MODEL_STREAM_END');
    return;
  }

  if (mode === 'invoke-tools') {
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: toolInvokeBody
      })
    );

    const bodyText = new TextDecoder().decode(response.body);
    console.log('MODEL_TEXT_START');
    console.log(bodyText);
    console.log('MODEL_TEXT_END');
    return;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

main().catch(error => {
  const details = {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    httpStatusCode: error?.$metadata?.httpStatusCode,
    requestId: error?.$metadata?.requestId,
    fault: error?.$fault,
    code: error?.code
  };

  console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
});