// In-process mock of a generic OpenAI-compatible server (Ollama, vLLM, LM Studio,
// OpenRouter …) for the custom-endpoint e2e specs. Unlike `mockGatewayServer`,
// it answers both streamed and non-streamed chat requests — the connection test
// uses both — and its gaps are switchable, one per capability the test probes:
//
//   GET  <apiPath>/models             → { data: [{ id }] }
//   POST <apiPath>/chat/completions   → JSON, or SSE when `stream: true`
//
// `apiPath` is configurable so a spec can prove the endpoint's own path is used
// exactly as configured (no `/v1` guessing).

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOpenAiCompatibleRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockOpenAiCompatibleServer {
  baseUrl: string;
  requests: MockOpenAiCompatibleRequest[];
  close(): Promise<void>;
}

export async function startMockOpenAiCompatibleServer(options: {
  apiPath?: string;
  models?: string[];
  /** When false, a request carrying `tools` is answered in plain text — like a model with no tool support. */
  tools?: boolean;
  /** Reply text for chat requests. */
  reply?: string;
}): Promise<MockOpenAiCompatibleServer> {
  const apiPath = options.apiPath ?? '/v1';
  const models = options.models ?? ['mock-model'];
  const reply = options.reply ?? 'Mock endpoint reply: done.';
  const requests: MockOpenAiCompatibleRequest[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url === `${apiPath}/models`) {
        json(200, { object: 'list', data: models.map(id => ({ id, object: 'model' })) });
        return;
      }
      if (req.method !== 'POST' || req.url !== `${apiPath}/chat/completions`) {
        json(404, { error: { message: `No route ${req.method} ${req.url}` } });
        return;
      }
      const payload = JSON.parse(body || '{}') as {
        stream?: boolean;
        stream_options?: unknown;
        tools?: Array<{ function?: { name?: string } }>;
      };
      // Only the connection test's `get_time` tool is ever called; an agent session's turn is answered in text.
      const toolName = options.tools !== false ? payload.tools?.[0]?.function?.name : undefined;
      const callTool = toolName === 'get_time';

      if (!payload.stream) {
        json(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [{
            index: 0,
            finish_reason: callTool ? 'tool_calls' : 'stop',
            message: callTool
              ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: '{"timezone":"UTC"}' } }] }
              : { role: 'assistant', content: reply }
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] });
      chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (payload.stream_options) {
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      }
      res.end('data: [DONE]\n\n');
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
