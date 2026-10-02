// In-process mock of the Vercel AI Gateway for Playwright e2e tests of the
// `@praxis/desktop-main` package.
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
  /** Number of `GET /v1/models` hits — lets a test assert the model catalog cache is actually being reused. */
  modelsRequestCount: number;
  /** Switches how chat requests are answered from now on — e.g. `error` → `complete` to simulate a credit top-up. */
  setMode(mode: 'complete' | 'hang' | 'error'): void;
  close(): Promise<void>;
}

const COMPLETE_REPLY = 'Mock gateway reply: task received and finished.';

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startMockGatewayServer(options: {
  mode: 'complete' | 'hang' | 'error';
  errorStatus?: number;
  errorBody?: string;
  /** Custom assistant reply body — overrides the default one-liner (e.g. a
   *  workflow run that must end with a DELIVERY_RESULT / FEATURE_DECOMPOSITION_RESULT
   *  JSON block for the completion watcher to parse). */
  reply?: string;
  /** Per-request reply chosen from the raw request body (e.g. by workflow stage); falls back to `reply`. */
  replyFor?: (body: string) => string | undefined;
  /** `/v1/models` response — defaults to a single `mock/model` entry.
   *  `context_length` is what the app reads to size the context indicator. */
  models?: Array<{ id: string; name?: string; context_length?: number }>;
  /** Token usage to report on the final chunk, as a real provider does. */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Optional first-turn tool call; the following request receives `reply`. */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /**
   * Explicit per-request round trips, taking precedence over `toolCall`/
   * `toolCalls`/`reply`. Each entry answers one request: `content` is the
   * assistant text for that round trip (so a test can reproduce an agent that
   * narrates between tool calls — the shape that produces one message event
   * per round trip), and `toolCalls` makes the loop continue. A request with
   * neither terminates the turn with `reply`. Opt-in, so existing callers are
   * unaffected.
   */
  roundTrips?: Array<{
    content?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;
  /** Optional first-turn tool calls; useful for exercising a long activity history. */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Delay completion so a test can interact with an in-flight session. */
  responseDelayMs?: number;
}): Promise<MockGatewayServer> {
  const reply = options.reply ?? COMPLETE_REPLY;
  const models = options.models ?? [{ id: 'mock/model' }];
  let currentMode = options.mode;
  const requests: MockGatewayRequest[] = [];
  const openResponses = new Set<http.ServerResponse>();
  let modelsRequestCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        requests.push({ authorization: req.headers.authorization, body });

        if (currentMode === 'error') {
          res.writeHead(options.errorStatus ?? 429, { 'Content-Type': 'application/json' });
          res.end(options.errorBody ?? JSON.stringify({
            error: {
              code: '1113',
              message: 'Insufficient balance or no resource package. Please recharge.'
            }
          }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const roundTrips = options.roundTrips;
        const roundTrip = roundTrips?.[requests.length - 1];
        const toolCalls = roundTrip
          ? roundTrip.toolCalls ?? []
          : options.toolCalls ?? (options.toolCall ? [options.toolCall] : []);
        const shouldCallTool = toolCalls.length > 0 && (roundTrips ? roundTrip !== undefined : requests.length === 1);
        const roundTripContent = roundTrip ? roundTrip.content : undefined;
        res.write(sseChunk({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: shouldCallTool
              ? {
                  role: 'assistant',
                  // A round trip that both talks and calls a tool sends
                  // `content` alongside `tool_calls` — how a real provider
                  // narrates before acting, and what makes each round trip
                  // surface as its own message event.
                  ...(roundTripContent !== undefined ? { content: roundTripContent } : {}),
                  tool_calls: toolCalls.map((toolCall, index) => ({
                    index,
                    id: `call_mock_${index + 1}`,
                    type: 'function',
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.arguments)
                    }
                  }))
                }
              : {
                  role: 'assistant',
                  // A round trip that both talks and calls a tool has to send
                  // `content` alongside `tool_calls` — that is how a real
                  // provider narrates before acting, and it is what makes each
                  // round trip surface as its own message event.
                  ...(roundTripContent !== undefined
                    ? { content: roundTripContent, tool_calls: toolCalls.map((tc, index) => ({
                        index,
                        id: `call_rt_${index + 1}`,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                      })) }
                    : { content: options.replyFor?.(body) ?? reply })
                },
            finish_reason: null
          }]
        }));

        if (currentMode === 'complete') {
          res.write(
            sseChunk({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: shouldCallTool ? 'tool_calls' : 'stop' }]
            })
          );
          if (options.usage) {
            // A real provider sends usage on a final chunk carrying no choices
            // at all, which is exactly the shape the parser has to survive.
            res.write(
              sseChunk({
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                choices: [],
                usage: {
                  prompt_tokens: options.usage.prompt_tokens,
                  completion_tokens: options.usage.completion_tokens,
                  total_tokens: options.usage.prompt_tokens + options.usage.completion_tokens
                }
              })
            );
          }
          const finish = () => {
            res.write('data: [DONE]\n\n');
            res.end();
          };
          if (options.responseDelayMs) setTimeout(finish, options.responseDelayMs);
          else finish();
        } else {
          // 'hang': keep the stream open so the session stays in-flight.
          openResponses.add(res);
          res.on('close', () => openResponses.delete(res));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      modelsRequestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models }));
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
    get modelsRequestCount() {
      return modelsRequestCount;
    },
    setMode(mode) {
      currentMode = mode;
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const res of openResponses) {
          res.destroy();
        }
        server.close(() => resolve());
      })
  };
}
