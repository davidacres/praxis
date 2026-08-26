import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import {
  GatewayHttpError,
  isRetryableGatewayHttpStatus,
  type ChatStreamHandle,
  type GatewayOptions,
  type RawGatewayModel
} from '../gateway/gatewayClient';

/**
 * Minimal HTTP/HTTPS client for Anthropic's Messages API. Structurally
 * mirrors `gateway/gatewayClient.ts`'s `postChatStream` (same retry/backoff/
 * idle-timeout behavior via the shared `GatewayHttpError`/
 * `isRetryableGatewayHttpStatus` helpers) but targets `/v1/messages` with
 * Anthropic's `x-api-key`/`anthropic-version` auth instead of OpenAI-style
 * Bearer auth — different enough from the OpenAI-compatible client that
 * sharing one implementation would need more indirection than it saves.
 */

const ANTHROPIC_VERSION = '2023-06-01';

function requestModule(target: string): typeof http | typeof https {
  return target.startsWith('https:') ? https : http;
}

function buildAnthropicHeaders(
  opts: GatewayOptions,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...extra
  };
  if (opts.apiKey) {
    headers['x-api-key'] = opts.apiKey;
  }
  return headers;
}

/**
 * Fetch the raw model list from `<url>/v1/models` — Anthropic's Models API.
 * Same idea as `gateway/gatewayClient.ts`'s `fetchModels`, but with
 * `x-api-key`/`anthropic-version` auth instead of Bearer, and Anthropic's
 * `{data: [{id, display_name}]}` shape (mapped onto `RawGatewayModel.name`
 * so callers don't need to know the difference).
 */
export function fetchAnthropicModels(opts: GatewayOptions, timeoutMs = 10000): Promise<RawGatewayModel[]> {
  const target = `${opts.url.replace(/\/$/, '')}/v1/models`;
  const isHttps = target.startsWith('https:');
  const client = requestModule(target);
  const u = new URL(target);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: buildAnthropicHeaders(opts),
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !opts.allowInsecureTls } : {})
      },
      res => {
        let body = '';
        res.on('data', c => {
          body += c;
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            return reject(new GatewayHttpError(res.statusCode ?? 0, body));
          }
          try {
            const json = JSON.parse(body) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
            const data = Array.isArray(json.data) ? json.data : [];
            resolve(
              data
                .filter((m): m is { id: string; display_name?: unknown } => typeof m?.id === 'string')
                .map(m => ({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : undefined }))
            );
          } catch (err) {
            reject(new Error(`Failed to parse Anthropic model list: ${(err as Error).message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * POST a Messages request to `<url>/v1/messages` and return a line stream of
 * the (streaming) response body.
 */
export function postMessagesStream(
  opts: GatewayOptions,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = 300000,
  maxRetries = 3
): Promise<ChatStreamHandle> {
  const target = `${opts.url.replace(/\/$/, '')}/v1/messages`;
  const isHttps = target.startsWith('https:');
  const client = requestModule(target);
  const u = new URL(target);
  const bodyText = JSON.stringify(payload);

  let attempt = 0;

  const tryRequest = (): Promise<ChatStreamHandle> => {
    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: buildAnthropicHeaders(opts, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyText).toString(),
            Accept: 'text/event-stream'
          }),
          timeout: 0,
          ...(isHttps ? { rejectUnauthorized: !opts.allowInsecureTls } : {})
        },
        res => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let body = '';
            res.on('data', c => {
              body += c;
            });
            res.on('end', () => {
              if (isRetryableGatewayHttpStatus(status) && attempt < maxRetries) {
                attempt++;
                const delay = Math.pow(2, attempt - 1) * 1000;
                setTimeout(() => {
                  tryRequest().then(resolve).catch(reject);
                }, delay);
              } else {
                reject(new GatewayHttpError(status, body));
              }
            });
            return;
          }

          if (timeoutMs > 0) {
            let idleTimer: NodeJS.Timeout | undefined = setTimeout(
              () => res.destroy(new Error('timeout')),
              timeoutMs
            );
            res.on('data', () => {
              if (idleTimer) {
                clearTimeout(idleTimer);
              }
              idleTimer = setTimeout(() => res.destroy(new Error('timeout')), timeoutMs);
            });
            res.on('end', () => {
              if (idleTimer) {
                clearTimeout(idleTimer);
              }
            });
            res.on('error', () => {
              if (idleTimer) {
                clearTimeout(idleTimer);
              }
            });
            res.on('close', () => {
              if (idleTimer) {
                clearTimeout(idleTimer);
              }
            });
          }

          // Pause until the consumer starts iterating; otherwise Node can
          // emit/end the body before anyone is listening and drop all SSE lines.
          res.pause();
          resolve({ statusCode: status, lines: toLines(res) });
        }
      );

      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      }

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      }

      req.on('error', err => {
        const isTransient =
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('timeout');
        if (isTransient && attempt < maxRetries) {
          attempt++;
          const delay = Math.pow(2, attempt - 1) * 1000;
          setTimeout(() => {
            tryRequest().then(resolve).catch(reject);
          }, delay);
        } else {
          reject(err);
        }
      });

      req.write(bodyText);
      req.end();
    });
  };

  return tryRequest();
}

async function* toLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  const resumable = stream as NodeJS.ReadableStream & { resume?: () => void };
  resumable.resume?.();

  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      yield line;
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
