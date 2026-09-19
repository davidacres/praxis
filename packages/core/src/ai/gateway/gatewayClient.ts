import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

/**
 * Minimal HTTP/HTTPS client for the Vercel AI Gateway.
 * Kept dependency-free and VS Code-free so it can be extracted later.
 */

export interface GatewayOptions {
  url: string;
  apiKey?: string;
  allowInsecureTls?: boolean;
  /** Path prefix before the standard `/models` and `/chat/completions` routes. */
  apiPath?: string;
}

export function isZaiHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes('z.ai') || hostname.includes('bigmodel.cn');
  } catch {
    return url.toLowerCase().includes('z.ai') || url.toLowerCase().includes('bigmodel.cn');
  }
}

export function alternateZaiApiPath(currentPath?: string): string {
  const normalized = (currentPath ?? '').toLowerCase();
  if (normalized.includes('/coding/')) {
    return '/api/paas/v4';
  }
  return '/api/coding/paas/v4';
}

const resolvedZaiApiPaths = new Map<string, string>();

function zaiKey(opts: GatewayOptions): string {
  return `${opts.url.toLowerCase()}::${opts.apiKey ?? ''}`;
}

export function recordWorkingZaiApiPath(opts: GatewayOptions, path: string): void {
  resolvedZaiApiPaths.set(zaiKey(opts), path);
}

export function resolveEffectiveOptions(opts: GatewayOptions): GatewayOptions {
  if (isZaiHost(opts.url)) {
    const preferred = resolvedZaiApiPaths.get(zaiKey(opts));
    if (preferred && preferred !== opts.apiPath) {
      return { ...opts, apiPath: preferred };
    }
  }
  return opts;
}

export function isNonRetryableRateLimit(body: string): boolean {
  return /"1113"|"1001"|insufficient[_ -]?(?:quota|balance|funds)|no resource package|please recharge|credit balance (?:is )?too low/i.test(body);
}

export function endpoint(opts: GatewayOptions, suffix: string): string {
  const cleanUrl = opts.url.replace(/\/+$/, '');
  let cleanPath = (opts.apiPath ?? '/v1').replace(/\/+$/, '');
  if (!cleanPath.startsWith('/')) {
    cleanPath = `/${cleanPath}`;
  }

  try {
    const u = new URL(cleanUrl);
    if (u.pathname && u.pathname !== '/') {
      if (cleanUrl.toLowerCase().endsWith(cleanPath.toLowerCase())) {
        return `${cleanUrl}${suffix}`;
      }
      if (/\/api\/|\/v1\b/i.test(u.pathname)) {
        return `${cleanUrl}${suffix}`;
      }
    }
  } catch {
    // fallback if not a standard absolute URL
  }

  return `${cleanUrl}${cleanPath}${suffix}`;
}

export interface GatewayModelArchitecture {
  input_modalities?: string[];
  output_modalities?: string[];
}

export interface RawGatewayModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  name?: string;
  normalized_name?: string;
  architecture?: GatewayModelArchitecture;
  [key: string]: unknown;
}

function requestModule(target: string): typeof http | typeof https {
  return target.startsWith('https:') ? https : http;
}

function buildHeaders(opts: GatewayOptions, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  return headers;
}

/** Fetch the raw model list from `<url>/v1/models`. */
export function fetchModels(opts: GatewayOptions, timeoutMs = 10000): Promise<RawGatewayModel[]> {
  opts = resolveEffectiveOptions(opts);
  const target = endpoint(opts, '/models');
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
        headers: buildHeaders(opts),
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
            if (res.statusCode === 429 && isZaiHost(opts.url) && body.includes('1113') && !(opts as { _zaiFallback?: boolean })._zaiFallback) {
              const altPath = alternateZaiApiPath(opts.apiPath);
              fetchModels({ ...opts, apiPath: altPath, _zaiFallback: true } as GatewayOptions, timeoutMs)
                .then(result => {
                  recordWorkingZaiApiPath(opts, altPath);
                  resolve(result);
                })
                .catch(reject);
              return;
            }
            return reject(new GatewayHttpError(res.statusCode ?? 0, body));
          }
          try {
            const json = JSON.parse(body) as { data?: unknown };
            const data = Array.isArray(json.data) ? json.data : [];
            resolve(
              data.filter(
                (m: unknown): m is RawGatewayModel =>
                  !!m && typeof (m as RawGatewayModel).id === 'string'
              )
            );
          } catch (err) {
            reject(new Error(`Failed to parse gateway model list: ${(err as Error).message}`));
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
 * Auth probe via `<url>/v1/chat/completions`.
 * Valid keys typically return 400 for the fake model; bad keys return 401/403.
 */
export function probeApiKeyAuth(opts: GatewayOptions, timeoutMs = 10_000, probeModel?: string): Promise<void> {
  opts = resolveEffectiveOptions(opts);
  const target = endpoint(opts, '/chat/completions');
  const isHttps = target.startsWith('https:');
  const client = requestModule(target);
  const u = new URL(target);
  const model = probeModel?.trim() || '__ticket_manager_auth_probe__';
  const bodyText = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false
  });

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: buildHeaders(opts, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText).toString()
        }),
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !opts.allowInsecureTls } : {})
      },
      res => {
        let body = '';
        res.on('data', c => {
          body += c;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status === 429 && isZaiHost(opts.url) && body.includes('1113') && !(opts as { _zaiFallback?: boolean })._zaiFallback) {
            const altPath = alternateZaiApiPath(opts.apiPath);
            probeApiKeyAuth({ ...opts, apiPath: altPath, _zaiFallback: true } as GatewayOptions, timeoutMs, probeModel)
              .then(() => {
                recordWorkingZaiApiPath(opts, altPath);
                resolve();
              })
              .catch(reject);
            return;
          }
          if (status === 401 || status === 403 || status === 429) {
            reject(new GatewayHttpError(status, body));
            return;
          }
          if (status >= 400 && status !== 400) {
            reject(new GatewayHttpError(status, body));
            return;
          }
          resolve();
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

export interface ChatStreamHandle {
  lines: AsyncIterable<string>;
  statusCode: number;
}

export function isRetryableGatewayHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * POST a chat request to `<url>/v1/chat/completions` and return a line stream
 * of the (streaming) response body.
 */
export function postChatStream(
  opts: GatewayOptions,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = 300000,
  maxRetries = 3
): Promise<ChatStreamHandle> {
  opts = resolveEffectiveOptions(opts);
  const target = endpoint(opts, '/chat/completions');
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
          headers: buildHeaders(opts, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyText).toString(),
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'Accept-Encoding': 'identity'
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
              if (status === 429 && isZaiHost(opts.url) && body.includes('1113') && !(opts as { _zaiFallback?: boolean })._zaiFallback) {
                const altPath = alternateZaiApiPath(opts.apiPath);
                postChatStream(
                  { ...opts, apiPath: altPath, _zaiFallback: true } as GatewayOptions,
                  payload,
                  signal,
                  timeoutMs,
                  maxRetries
                )
                  .then(handle => {
                    recordWorkingZaiApiPath(opts, altPath);
                    resolve(handle);
                  })
                  .catch(reject);
                return;
              }
              const nonRetryable = isNonRetryableRateLimit(body);
              if (!nonRetryable && isRetryableGatewayHttpStatus(status) && attempt < maxRetries) {
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

export function formatGatewayErrorMessage(statusCode: number, body: string): string {
  if (!body?.trim()) {
    return `Gateway returned HTTP ${statusCode}`;
  }
  try {
    const jsonMatch = body.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const err = (obj.error && typeof obj.error === 'object') ? (obj.error as Record<string, unknown>) : obj;
      const msg = typeof err.message === 'string' ? err.message : typeof err.msg === 'string' ? err.msg : undefined;
      const code = err.code ?? obj.code;
      if (msg?.trim()) {
        const details = [code !== undefined && code !== '' ? `Code ${code}` : undefined, `HTTP ${statusCode}`].filter(Boolean);
        return `${msg.trim()} (${details.join(' · ')})`;
      }
    }
  } catch {
    // not JSON
  }
  return `Gateway returned HTTP ${statusCode}: ${body.slice(0, 300)}`;
}

export class GatewayHttpError extends Error {
  constructor(
    public statusCode: number,
    public body: string
  ) {
    super(formatGatewayErrorMessage(statusCode, body));
    this.name = 'GatewayHttpError';
  }
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
