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
 * Minimal HTTP/HTTPS client for Google Gemini's GenerateContent REST API.
 * Structurally mirrors `anthropicClient.ts` and `gatewayClient.ts` (same
 * retry/backoff/idle-timeout behavior via shared helpers) targeting
 * `/v1beta/models/{model}:streamGenerateContent?alt=sse` with
 * `x-goog-api-key` auth.
 */

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

function requestModule(target: string): typeof http | typeof https {
  return target.startsWith('https:') ? https : http;
}

function buildGeminiHeaders(
  opts: GatewayOptions,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra
  };
  if (opts.apiKey) {
    headers['x-goog-api-key'] = opts.apiKey;
  }
  return headers;
}

/**
 * Fetch the raw model list from `<url>/v1beta/models`.
 * Filters for models supporting `generateContent`.
 */
export function fetchGeminiModels(opts: GatewayOptions, timeoutMs = 10000): Promise<RawGatewayModel[]> {
  const baseUrl = (opts.url?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const target = `${baseUrl}/v1beta/models`;
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
        headers: buildGeminiHeaders(opts),
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
            const json = JSON.parse(body) as {
              models?: Array<{
                name?: unknown;
                displayName?: unknown;
                description?: unknown;
                supportedGenerationMethods?: unknown;
                inputTokenLimit?: unknown;
              }>;
            };
            const models = Array.isArray(json.models) ? json.models : [];
            const result: RawGatewayModel[] = [];

            for (const m of models) {
              if (typeof m?.name !== 'string') continue;
              const methods = Array.isArray(m.supportedGenerationMethods)
                ? (m.supportedGenerationMethods as unknown[])
                : [];
              if (methods.length > 0 && !methods.includes('generateContent')) {
                continue;
              }
              const id = m.name.replace(/^models\//, '');
              result.push({
                id,
                name: typeof m.displayName === 'string' ? m.displayName : id,
                description: typeof m.description === 'string' ? m.description : undefined,
                context_length: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined
              });
            }

            resolve(result);
          } catch (err) {
            reject(new Error(`Failed to parse Gemini model list: ${(err as Error).message}`));
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
 * POST a GenerateContent request to `<url>/v1beta/models/{model}:streamGenerateContent?alt=sse`
 * and return an async line stream of the SSE response body.
 */
export function postGeminiStream(
  opts: GatewayOptions,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = 300000,
  maxRetries = 3
): Promise<ChatStreamHandle> {
  const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const model = typeof payloadObj.model === 'string' && payloadObj.model.trim()
    ? payloadObj.model.trim()
    : 'gemini-2.5-flash';

  // Strip `model` from the request body sent to Gemini REST API
  const { model: _strippedModel, ...bodyToSend } = payloadObj;
  const bodyText = JSON.stringify(bodyToSend);

  const baseUrl = (opts.url?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const cleanModel = model.replace(/^models\//, '');
  const target = `${baseUrl}/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse`;

  const isHttps = target.startsWith('https:');
  const client = requestModule(target);
  const u = new URL(target);

  let attempt = 0;

  const tryRequest = (): Promise<ChatStreamHandle> => {
    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: buildGeminiHeaders(opts, {
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

          // Pause until the consumer starts iterating
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

