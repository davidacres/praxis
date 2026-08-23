// In-process mock of the Vercel AI Gateway for Playwright e2e tests of the
// `@ticket-manager/electron-app` package.
//
// Speaks just enough of the OpenAI-compatible chat-completions wire protocol
// for `postChatStream` + `consumeChatStream` in core's `ai/gateway`:
//
//   POST <baseUrl>/v1/chat/completions   (Accept: text/event-stream)
//   → 200 text/event-stream with SSE chunks:
//       data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"…"}}]}
//       data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
//       data: [DONE]
//
// Two modes:
//   - 'complete': the full SSE body is written and ended immediately, so a
//     delegated agent session runs to `completed` with no tool calls.
//   - 'hang': headers + a first delta are written but the stream never ends,
//     so the session stays in-flight until the test aborts it.
//
// Every request's Authorization header and raw body are recorded in
// `requests` for assertions (the API key must arrive as `Bearer <key>`).

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockGatewayRequest {
  authorization: string | undefined;
  body: string;
}

export interface MockGatewayServer {
  baseUrl: string;
  requests: MockGatewayRequest[];
  close(): Promise<void>;
}

const COMPLETE_REPLY = 'Mock gateway reply: task received and finished.';

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startMockGatewayServer(options: {
  mode: 'complete' | 'hang';
  /** Custom assistant reply body — overrides the default one-liner (e.g. a
   *  workflow run that must end with a DELIVERY_RESULT / FEATURE_DECOMPOSITION_RESULT
   *  JSON block for the completion watcher to parse). */
  reply?: string;
}): Promise<MockGatewayServer> {
  const reply = options.reply ?? COMPLETE_REPLY;
  const requests: MockGatewayRequest[] = [];
  const openResponses = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        requests.push({ authorization: req.headers.authorization, body });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(
          sseChunk({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: reply },
                finish_reason: null
              }
            ]
          })
        );

        if (options.mode === 'complete') {
          res.write(
            sseChunk({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // 'hang': keep the stream open so the session stays in-flight.
          openResponses.add(res);
          res.on('close', () => openResponses.delete(res));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock/model' }] }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        for (const res of openResponses) {
          res.destroy();
        }
        server.close(() => resolve());
      })
  };
}
