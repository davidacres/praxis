// In-process mock of Anthropic's Messages API for Playwright e2e tests,
// exercising `anthropicClient.ts`/`anthropicWire.ts` in `@ticket-manager/core`.
//
//   POST <baseUrl>/v1/messages   (x-api-key, anthropic-version headers)
//   → 200 text/event-stream with SSE chunks:
//       data: {"type":"message_start", ...}
//       data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}
//       data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}}
//       data: {"type":"content_block_stop","index":0}
//       data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
//       data: {"type":"message_stop"}
//
// Same two modes as `mockGatewayServer.ts`: 'complete' ends the stream so a
// delegated session runs to `completed`; 'hang' leaves it open.
//
// Every request's `x-api-key`/`anthropic-version` headers and raw body are
// recorded in `requests` for assertions.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAnthropicRequest {
  apiKey: string | undefined;
  anthropicVersion: string | undefined;
  body: string;
}

export interface MockAnthropicServer {
  baseUrl: string;
  requests: MockAnthropicRequest[];
  close(): Promise<void>;
}

const COMPLETE_REPLY = 'Mock Anthropic reply: task received and finished.';

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startMockAnthropicServer(options: {
  mode: 'complete' | 'hang';
  reply?: string;
}): Promise<MockAnthropicServer> {
  const reply = options.reply ?? COMPLETE_REPLY;
  const requests: MockAnthropicRequest[] = [];
  const openResponses = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        requests.push({
          apiKey: req.headers['x-api-key'] as string | undefined,
          anthropicVersion: req.headers['anthropic-version'] as string | undefined,
          body
        });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(sseChunk({ type: 'message_start', message: { id: 'msg-mock', usage: {} } }));
        res.write(sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        res.write(
          sseChunk({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: reply }
          })
        );

        if (options.mode === 'complete') {
          res.write(sseChunk({ type: 'content_block_stop', index: 0 }));
          res.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
          res.write(sseChunk({ type: 'message_stop' }));
          res.end();
        } else {
          // 'hang': keep the stream open so the session stays in-flight.
          openResponses.add(res);
          res.on('close', () => openResponses.delete(res));
        }
      });
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
