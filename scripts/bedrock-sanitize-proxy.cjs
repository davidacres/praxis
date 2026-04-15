const http = require('node:http');
const { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SignatureV4 } = require('@smithy/signature-v4');
const { Hash } = require('@smithy/hash-node');
const { HttpRequest } = require('@smithy/protocol-http');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { EventStreamCodec } = require('@smithy/eventstream-codec');
const { toUtf8, fromUtf8 } = require('@smithy/util-utf8');

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const port = Number(process.env.BEDROCK_PROXY_PORT || 8787);
const defaultModelId = process.env.BEDROCK_PROXY_MODEL || 'zai.glm-5';
const runtimeHostname = `bedrock-runtime.${region}.amazonaws.com`;
const controlHostname = `bedrock.${region}.amazonaws.com`;

const runtimeClient = new BedrockRuntimeClient({ region });
const httpHandler = new NodeHttpHandler();
const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

function normalizeStopReason(reason) {
  if (!reason || reason === 'stop') {
    return 'end_turn';
  }

  if (reason === 'length') {
    return 'max_tokens';
  }

  if (reason === 'tool_calls') {
    return 'tool_use';
  }

  return reason;
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function extractTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

function assertTextOnlyBlocks(blocks, label) {
  if (!Array.isArray(blocks)) {
    return;
  }

  const unsupported = blocks.find(block => block?.type !== 'text');

  if (unsupported) {
    throw new Error(`${label} contains unsupported content block type: ${unsupported.type || 'unknown'}`);
  }
}

function normalizeSystemBlocks(system) {
  if (typeof system === 'string') {
    return system;
  }

  if (!Array.isArray(system)) {
    return '';
  }

  assertTextOnlyBlocks(system, 'system');

  return system
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function sanitizeMetadataUserId(parsedBody) {
  const userId = parsedBody?.metadata?.user_id;

  if (typeof userId !== 'string' || !userId.trim().startsWith('{')) {
    return { body: parsedBody, changed: false };
  }

  try {
    const structured = JSON.parse(userId);
    const replacement = structured.session_id || structured.account_uuid || structured.device_id || 'claude-code';

    return {
      body: {
        ...parsedBody,
        metadata: {
          ...parsedBody.metadata,
          user_id: replacement
        }
      },
      changed: true,
      replacement
    };
  } catch {
    return {
      body: {
        ...parsedBody,
        metadata: {
          ...parsedBody.metadata,
          user_id: 'claude-code'
        }
      },
      changed: true,
      replacement: 'claude-code'
    };
  }
}

function mapAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
}

function mapAnthropicToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (toolChoice.type === 'auto') {
    return 'auto';
  }

  if (toolChoice.type === 'any') {
    return 'required';
  }

  if (toolChoice.type === 'none') {
    return 'none';
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name
      }
    };
  }

  return undefined;
}

function extractToolResultText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const unsupported = content.find(block => block?.type !== 'text');

  if (unsupported) {
    throw new Error(`tool_result contains unsupported content block type: ${unsupported.type || 'unknown'}`);
  }

  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

function pushUserTextMessage(target, textParts) {
  if (textParts.length === 0) {
    return;
  }

  target.push({ role: 'user', content: textParts.join('') });
  textParts.length = 0;
}

function translateAnthropicMessages(messages = [], system = []) {
  const translatedMessages = [];
  const systemText = normalizeSystemBlocks(system);

  if (systemText) {
    translatedMessages.push({ role: 'system', content: systemText });
  }

  for (const message of messages) {
    if (typeof message?.content === 'string') {
      translatedMessages.push({ role: message.role, content: message.content });
      continue;
    }

    if (!Array.isArray(message?.content)) {
      translatedMessages.push({ role: message.role, content: '' });
      continue;
    }

    const unsupported = message.content.find(block => !['text', 'tool_use', 'tool_result'].includes(block?.type));

    if (unsupported) {
      throw new Error(`message content contains unsupported block type: ${unsupported.type || 'unknown'}`);
    }

    const textContent = extractTextContent(message.content);
    const toolUseBlocks = message.content.filter(block => block?.type === 'tool_use');
    const toolResultBlocks = message.content.filter(block => block?.type === 'tool_result');

    if (message.role === 'assistant' && toolUseBlocks.length > 0) {
      translatedMessages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolUseBlocks.map(block => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        }))
      });
      continue;
    }

    if (message.role === 'user' && toolResultBlocks.length > 0) {
      const pendingUserText = [];

      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          pendingUserText.push(block.text);
          continue;
        }

        if (block?.type === 'tool_result') {
          pushUserTextMessage(translatedMessages, pendingUserText);
          translatedMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: extractToolResultText(block.content)
          });
        }
      }

      pushUserTextMessage(translatedMessages, pendingUserText);
      continue;
    }

    translatedMessages.push({ role: message.role, content: textContent });
  }

  return translatedMessages;
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)])
  );
}

function translateAnthropicRequestBody(parsedBody) {
  const sanitized = sanitizeMetadataUserId(parsedBody);
  const translatedBody = compactObject({
    messages: translateAnthropicMessages(sanitized.body.messages, sanitized.body.system),
    max_tokens: sanitized.body.max_tokens,
    temperature: sanitized.body.temperature,
    top_p: sanitized.body.top_p,
    stop: sanitized.body.stop_sequences,
    tools: mapAnthropicTools(sanitized.body.tools),
    tool_choice: mapAnthropicToolChoice(sanitized.body.tool_choice)
  });

  return {
    body: translatedBody,
    replacement: sanitized.replacement,
    translatedTools: Array.isArray(sanitized.body.tools) && sanitized.body.tools.length > 0,
    stream: sanitized.body.stream !== false,
    modelId: typeof sanitized.body.model === 'string' && sanitized.body.model ? sanitized.body.model : defaultModelId
  };
}

function prepareBedrockAdapterRequest(headers, bodyBuffer) {
  const contentType = String(headers['content-type'] || '');

  if (!contentType.includes('application/json') || bodyBuffer.length === 0) {
    return { bodyBuffer, changed: false };
  }

  try {
    const parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
    const translated = translateAnthropicRequestBody(parsedBody);

    return {
      bodyBuffer: Buffer.from(JSON.stringify(translated.body)),
      changed: true,
      replacement: translated.replacement,
      translatedTools: translated.translatedTools
    };
  } catch {
    return { bodyBuffer, changed: false };
  }
}

function prepareAnthropicMessagesRequest(bodyBuffer) {
  const parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
  const translated = translateAnthropicRequestBody(parsedBody);

  return {
    bodyBuffer: Buffer.from(JSON.stringify(translated.body)),
    replacement: translated.replacement,
    translatedTools: translated.translatedTools,
    stream: translated.stream,
    modelId: translated.modelId
  };
}

function buildForwardHeaders(headers, hostname, bodyBuffer) {
  const forwardHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();

    if (
      normalized === 'host' ||
      normalized === 'authorization' ||
      normalized === 'content-length' ||
      normalized === 'connection' ||
      normalized === 'accept-encoding' ||
      normalized === 'x-amz-date' ||
      normalized === 'x-amz-content-sha256' ||
      normalized === 'amz-sdk-invocation-id' ||
      normalized === 'amz-sdk-request' ||
      normalized === 'x-amz-user-agent'
    ) {
      continue;
    }

    forwardHeaders[normalized] = value;
  }

  forwardHeaders.host = hostname;
  forwardHeaders['content-length'] = String(bodyBuffer.length);
  return forwardHeaders;
}

function buildAnthropicMessagePayload(glmPayload) {
  const choice = glmPayload?.choices?.[0] || {};
  const message = choice.message || {};
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = [];

  if (text) {
    content.push({ type: 'text', text });
  }

  for (const toolCall of toolCalls) {
    let parsedInput = {};

    try {
      parsedInput = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      parsedInput = {};
    }

    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function?.name || 'tool',
      input: parsedInput
    });
  }

  return {
    id: glmPayload.id || `msg_bdrk_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: glmPayload.model || defaultModelId,
    content,
    stop_reason: normalizeStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: glmPayload?.usage?.prompt_tokens || 0,
      output_tokens: glmPayload?.usage?.completion_tokens || 0
    }
  };
}

function encodeBedrockEventChunk(jsonPayload) {
  return Buffer.from(
    eventStreamCodec.encode({
      headers: {
        ':message-type': { type: 'string', value: 'event' },
        ':event-type': { type: 'string', value: 'chunk' },
        ':content-type': { type: 'string', value: 'application/json' }
      },
      body: Buffer.from(JSON.stringify(jsonPayload))
    })
  );
}

function buildBedrockAdapterStreamFrames(glmPayload) {
  const anthropicMessage = buildAnthropicMessagePayload(glmPayload);
  const frames = [
    {
      type: 'message_start',
      message: {
        ...anthropicMessage,
        content: []
      }
    }
  ];

  anthropicMessage.content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: ''
        }
      });
      frames.push({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text
        }
      });
      frames.push({
        type: 'content_block_stop',
        index
      });
      return;
    }

    if (block.type === 'tool_use') {
      frames.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {}
        }
      });
      frames.push({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {})
        }
      });
      frames.push({
        type: 'content_block_stop',
        index
      });
    }
  });

  frames.push({
    type: 'message_delta',
    delta: {
      stop_reason: anthropicMessage.stop_reason,
      stop_sequence: null
    },
    usage: {
      output_tokens: anthropicMessage.usage.output_tokens
    }
  });
  frames.push({ type: 'message_stop' });

  return frames.map(encodeBedrockEventChunk);
}

function encodeSseEvent(jsonPayload) {
  return Buffer.from(`event: ${jsonPayload.type}\ndata: ${JSON.stringify(jsonPayload)}\n\n`, 'utf8');
}

function writeSseEvent(res, jsonPayload) {
  res.write(encodeSseEvent(jsonPayload));
}

function decodeStreamChunkPayload(event) {
  const bytes = event?.chunk?.bytes;

  if (!bytes) {
    return null;
  }

  const byteArray = bytes instanceof Uint8Array ? bytes : Uint8Array.from(Object.values(bytes));

  try {
    return JSON.parse(Buffer.from(byteArray).toString('utf8'));
  } catch {
    return null;
  }
}

function createAnthropicStreamState(modelId) {
  return {
    messageStarted: false,
    messageId: `msg_bdrk_${Date.now()}`,
    model: modelId || defaultModelId,
    nextContentIndex: 0,
    openTextIndex: null,
    openToolCalls: new Map()
  };
}

function ensureAnthropicMessageStart(res, state, glmPayload) {
  if (state.messageStarted) {
    return;
  }

  state.messageStarted = true;
  state.messageId = glmPayload?.id || state.messageId;
  state.model = glmPayload?.model || state.model;

  writeSseEvent(res, {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  });
}

function getToolCallStateKey(toolCall) {
  if (typeof toolCall?.index === 'number') {
    return `index:${toolCall.index}`;
  }

  if (typeof toolCall?.id === 'string' && toolCall.id) {
    return `id:${toolCall.id}`;
  }

  return `generated:${Date.now()}:${Math.random()}`;
}

function writeAnthropicToolCallEvents(res, state, toolCalls) {
  for (const toolCall of toolCalls) {
    const key = getToolCallStateKey(toolCall);
    let openToolCall = state.openToolCalls.get(key);

    if (!openToolCall) {
      openToolCall = {
        index: state.nextContentIndex,
        id: toolCall.id || `toolu_${state.nextContentIndex}`,
        name: toolCall.function?.name || 'tool'
      };
      state.nextContentIndex += 1;
      state.openToolCalls.set(key, openToolCall);

      writeSseEvent(res, {
        type: 'content_block_start',
        index: openToolCall.index,
        content_block: {
          type: 'tool_use',
          id: openToolCall.id,
          name: openToolCall.name,
          input: {}
        }
      });
    }

    if (typeof toolCall.function?.arguments === 'string' && toolCall.function.arguments) {
      writeSseEvent(res, {
        type: 'content_block_delta',
        index: openToolCall.index,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.function.arguments
        }
      });
    }
  }
}

function closeAnthropicToolCalls(res, state) {
  for (const openToolCall of state.openToolCalls.values()) {
    writeSseEvent(res, {
      type: 'content_block_stop',
      index: openToolCall.index
    });
  }

  state.openToolCalls.clear();
}

function closeAnthropicTextBlock(res, state) {
  if (state.openTextIndex === null) {
    return;
  }

  writeSseEvent(res, {
    type: 'content_block_stop',
    index: state.openTextIndex
  });

  state.openTextIndex = null;
}

function writeAnthropicTextDelta(res, state, text) {
  if (!text) {
    return;
  }

  closeAnthropicToolCalls(res, state);

  if (state.openTextIndex === null) {
    state.openTextIndex = state.nextContentIndex;
    state.nextContentIndex += 1;

    writeSseEvent(res, {
      type: 'content_block_start',
      index: state.openTextIndex,
      content_block: {
        type: 'text',
        text: ''
      }
    });
  }

  writeSseEvent(res, {
    type: 'content_block_delta',
    index: state.openTextIndex,
    delta: {
      type: 'text_delta',
      text
    }
  });
}

function writeAnthropicMessageStop(res, state, glmPayload, finishReason) {
  closeAnthropicTextBlock(res, state);
  closeAnthropicToolCalls(res, state);

  const metrics = glmPayload?.['amazon-bedrock-invocationMetrics'] || {};

  writeSseEvent(res, {
    type: 'message_delta',
    delta: {
      stop_reason: normalizeStopReason(finishReason),
      stop_sequence: null
    },
    usage: {
      output_tokens: metrics.outputTokenCount || 0
    }
  });

  writeSseEvent(res, { type: 'message_stop' });
}

async function streamBedrockToAnthropicSse(modelId, bodyBuffer, res) {
  const response = await runtimeClient.send(
    new InvokeModelWithResponseStreamCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: bodyBuffer
    })
  );
  const state = createAnthropicStreamState(modelId);

  for await (const event of response.body) {
    const glmPayload = decodeStreamChunkPayload(event);

    if (!glmPayload) {
      continue;
    }

    ensureAnthropicMessageStart(res, state, glmPayload);

    const choice = glmPayload?.choices?.[0] || {};
    const delta = choice.delta || {};

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      closeAnthropicTextBlock(res, state);
      writeAnthropicToolCallEvents(res, state, delta.tool_calls);
    }

    writeAnthropicTextDelta(res, state, delta.content);

    if (choice.finish_reason) {
      writeAnthropicMessageStop(res, state, glmPayload, choice.finish_reason);
    }
  }
}

function buildAnthropicSseFrames(glmPayload) {
  const anthropicMessage = buildAnthropicMessagePayload(glmPayload);
  const frames = [
    {
      type: 'message_start',
      message: {
        ...anthropicMessage,
        content: []
      }
    }
  ];

  anthropicMessage.content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: ''
        }
      });
      frames.push({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text
        }
      });
      frames.push({
        type: 'content_block_stop',
        index
      });
      return;
    }

    if (block.type === 'tool_use') {
      frames.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {}
        }
      });
      frames.push({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {})
        }
      });
      frames.push({
        type: 'content_block_stop',
        index
      });
    }
  });

  frames.push({
    type: 'message_delta',
    delta: {
      stop_reason: anthropicMessage.stop_reason,
      stop_sequence: null
    },
    usage: {
      output_tokens: anthropicMessage.usage.output_tokens
    }
  });
  frames.push({ type: 'message_stop' });

  return frames.map(encodeSseEvent);
}

async function readResponseBody(response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks = [];

  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function sendSignedRequest(hostname, method, path, headers, bodyBuffer) {
  const signer = new SignatureV4({
    credentials: runtimeClient.config.credentials,
    region,
    service: 'bedrock',
    sha256: Hash.bind(null, 'sha256')
  });

  const signedRequest = await signer.sign(
    new HttpRequest({
      protocol: 'https:',
      hostname,
      method,
      path,
      headers,
      body: bodyBuffer.length > 0 ? bodyBuffer : undefined
    })
  );

  return httpHandler.handle(signedRequest);
}

async function invokeBedrockModel(modelId, bodyBuffer) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    host: runtimeHostname,
    'content-length': String(bodyBuffer.length)
  };
  const path = `/model/${modelId}/invoke`;
  const { response } = await sendSignedRequest(runtimeHostname, 'POST', path, headers, bodyBuffer);
  const responseBody = await readResponseBody(response);

  return {
    statusCode: response.statusCode || 502,
    headers: response.headers || {},
    bodyBuffer: responseBody
  };
}

async function forwardBedrockAdapterRequest(req, bodyBuffer, res) {
  const isRuntimeRequest = req.url.startsWith('/model/');
  const hostname = isRuntimeRequest ? runtimeHostname : controlHostname;
  const headers = buildForwardHeaders(req.headers, hostname, bodyBuffer);
  const upstreamPath = req.url.endsWith('/invoke-with-response-stream')
    ? req.url.replace('/invoke-with-response-stream', '/invoke')
    : req.url;
  const { response } = await sendSignedRequest(hostname, req.method, upstreamPath, headers, bodyBuffer);
  const responseBody = await readResponseBody(response);

  console.log(`${req.method} ${req.url} -> ${response.statusCode}`);

  res.statusCode = response.statusCode || 502;

  if (response.statusCode !== 200) {
    res.setHeader('content-type', 'application/json');
    res.end(responseBody);
    return;
  }

  if (req.url.endsWith('/invoke-with-response-stream')) {
    const glmPayload = JSON.parse(responseBody.toString('utf8'));
    const frames = buildBedrockAdapterStreamFrames(glmPayload);

    res.setHeader('content-type', 'application/vnd.amazon.eventstream');
    res.setHeader('x-amzn-bedrock-content-type', 'application/json');
    res.setHeader('transfer-encoding', 'chunked');

    for (const frame of frames) {
      res.write(frame);
    }

    res.end();
    return;
  }

  if (req.url.endsWith('/invoke')) {
    const glmPayload = JSON.parse(responseBody.toString('utf8'));
    const anthropicPayload = buildAnthropicMessagePayload(glmPayload);
    writeJson(res, 200, anthropicPayload);
    return;
  }

  for (const [key, value] of Object.entries(response.headers || {})) {
    if (value !== undefined) {
      res.setHeader(key, value);
    }
  }

  res.end(responseBody);
}

async function forwardAnthropicMessagesRequest(req, bodyBuffer, res) {
  let prepared;

  try {
    prepared = prepareAnthropicMessagesRequest(bodyBuffer);
  } catch (error) {
    console.error(`${req.method} ${req.url} -> invalid JSON: ${error?.message || String(error)}`);
    writeJson(res, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Request body must be valid JSON'
      }
    });
    return;
  }

  const parts = [];

  if (prepared.replacement) {
    parts.push(`metadata.user_id -> ${prepared.replacement}`);
  }

  if (prepared.translatedTools) {
    parts.push('translated anthropic tools');
  }

  console.log(
    `${req.method} ${req.url} -> invoking ${prepared.modelId}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`
  );

  if (!prepared.stream) {
    const upstream = await invokeBedrockModel(prepared.modelId, prepared.bodyBuffer);

    if (upstream.statusCode !== 200) {
      res.statusCode = upstream.statusCode;
      res.setHeader('content-type', 'application/json');
      res.end(upstream.bodyBuffer);
      return;
    }

    const glmPayload = JSON.parse(upstream.bodyBuffer.toString('utf8'));
    writeJson(res, 200, buildAnthropicMessagePayload(glmPayload));
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  try {
    await streamBedrockToAnthropicSse(prepared.modelId, prepared.bodyBuffer, res);
    res.end();
  } catch (error) {
    console.error(`${req.method} ${req.url} -> streaming proxy error: ${error?.message || String(error)}`);
    if (!res.headersSent) {
      writeJson(res, 502, { error: error?.message || String(error) });
      return;
    }

    res.end();
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];

    if ((req.method === 'HEAD' || req.method === 'GET') && requestUrl.pathname === '/') {
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/inference-profiles') {
      console.log(`${req.method} ${req.url} -> 200 (local)`);
      writeJson(res, 200, { inferenceProfileSummaries: [] });
      return;
    }

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const originalBody = Buffer.concat(chunks);

      try {
        if (req.method === 'POST' && requestUrl.pathname === '/v1/messages') {
          await forwardAnthropicMessagesRequest(req, originalBody, res);
          return;
        }

        const prepared = prepareBedrockAdapterRequest(req.headers, originalBody);

        if (prepared.changed) {
          const parts = [];

          if (prepared.replacement) {
            parts.push(`metadata.user_id -> ${prepared.replacement}`);
          }

          if (prepared.translatedTools) {
            parts.push('translated anthropic tools');
          }

          console.log(`translated request: ${parts.join(', ')}`);
        }

        await forwardBedrockAdapterRequest(req, prepared.bodyBuffer, res);
      } catch (error) {
        console.error(`${req.method} ${req.url} -> proxy error: ${error?.message || String(error)}`);
        writeJson(res, 502, { error: error?.message || String(error) });
      }
    });
  });
}

function startServer() {
  const server = createServer();

  server.listen(port, '127.0.0.1', () => {
    console.log(`bedrock sanitize proxy listening on http://127.0.0.1:${port}`);
    console.log(`forwarding to region ${region}`);
    console.log(`default Anthropic proxy model ${defaultModelId}`);
  });

  return server;
}

module.exports = {
  normalizeStopReason,
  sanitizeMetadataUserId,
  mapAnthropicTools,
  mapAnthropicToolChoice,
  extractTextContent,
  extractToolResultText,
  translateAnthropicMessages,
  translateAnthropicRequestBody,
  buildAnthropicMessagePayload,
  buildAnthropicSseFrames,
  buildBedrockAdapterStreamFrames,
  createServer,
  startServer
};

if (require.main === module) {
  startServer();
}
