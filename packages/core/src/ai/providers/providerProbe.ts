import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { buildHeaders, endpoint, type GatewayOptions } from '../gateway/gatewayClient';
import type { ProviderCapabilities, ProviderProbeStepId } from './customProviders';

export type ProviderProbeStepStatus = 'pass' | 'fail' | 'skipped';

export interface ProviderProbeStep {
  id: ProviderProbeStepId;
  status: ProviderProbeStepStatus;
  /** Plain-language result, e.g. "GET /models → 200, 3 models". Never contains the key. */
  detail: string;
}

export interface ProviderProbeResult {
  steps: ProviderProbeStep[];
  capabilities: ProviderCapabilities;
  /** Model ids the server listed, for the form's model picker. */
  models: string[];
}

interface HttpResult {
  status: number;
  body: string;
}

const STEP_TIMEOUT_MS = 20_000;
const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Returns the current time in a timezone.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. UTC' } },
      required: ['timezone']
    }
  }
};

function send(opts: GatewayOptions, method: 'GET' | 'POST', suffix: string, payload?: unknown, timeoutMs = STEP_TIMEOUT_MS): Promise<HttpResult> {
  const target = endpoint(opts, suffix);
  const url = new URL(target);
  const isHttps = url.protocol === 'https:';
  const bodyText = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: buildHeaders(opts, bodyText === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText).toString()
        }),
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !opts.allowInsecureTls } : {})
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A short, key-free reason from an error body: the provider's own `error.message` when it sends one. */
function reason(result: HttpResult, apiKey: string | undefined): string {
  const parsed = parseJson(result.body) as { error?: { message?: unknown } | string; message?: unknown } | undefined;
  const fromError = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
  const raw = typeof fromError === 'string' ? fromError : typeof parsed?.message === 'string' ? parsed.message : result.body;
  let text = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (apiKey) text = text.split(apiKey).join('•••');
  return text ? `HTTP ${result.status}: ${text}` : `HTTP ${result.status}`;
}

function networkReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Can't reach the server — ${message}`;
}

/** Streamed SSE body → whether any content arrived and whether a chunk carried `usage`. */
function readStream(body: string): { chunks: number; usage: boolean } {
  let chunks = 0;
  let usage = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') continue;
    const parsed = parseJson(data) as { usage?: unknown; choices?: unknown } | undefined;
    if (!parsed) continue;
    chunks++;
    if (parsed.usage && typeof parsed.usage === 'object') usage = true;
  }
  return { chunks, usage };
}

/**
 * Tests what an OpenAI-compatible endpoint actually supports, in the order a
 * session depends on it. Each step records pass / fail / skipped with the
 * server's own reason; nothing throws. At most four small requests — one
 * model list and three completions capped at a few dozen tokens — so it is
 * safe to run on demand, but it is never run automatically.
 */
export async function probeOpenAiCompatible(opts: GatewayOptions, preferredModel?: string): Promise<ProviderProbeResult> {
  const steps: ProviderProbeStep[] = [];
  const capabilities: ProviderCapabilities = {
    models: false,
    chat: false,
    streaming: false,
    streamUsage: false,
    tools: false,
    probedAt: new Date().toISOString()
  };
  const skipRest = (from: ProviderProbeStepId[], detail: string): void => {
    for (const id of from) steps.push({ id, status: 'skipped', detail });
  };

  // 1 — reachable, key accepted, model list.
  let models: string[] = [];
  try {
    const listed = await send(opts, 'GET', '/models');
    if (listed.status === 401 || listed.status === 403) {
      steps.push({ id: 'models', status: 'fail', detail: `API key rejected — ${reason(listed, opts.apiKey)}` });
      skipRest(['chat', 'streaming', 'tools'], 'Fix the key first.');
      return { steps, capabilities, models };
    }
    if (listed.status >= 200 && listed.status < 300) {
      const data = (parseJson(listed.body) as { data?: Array<{ id?: unknown }> } | undefined)?.data;
      models = Array.isArray(data) ? data.map(model => model.id).filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      capabilities.models = true;
      steps.push({ id: 'models', status: 'pass', detail: `${models.length} model${models.length === 1 ? '' : 's'} listed` });
    } else {
      steps.push({ id: 'models', status: 'fail', detail: `No model list (${reason(listed, opts.apiKey)}). Add model ids by hand.` });
    }
  } catch (error) {
    steps.push({ id: 'models', status: 'fail', detail: networkReason(error) });
    skipRest(['chat', 'streaming', 'tools'], 'The server did not respond.');
    return { steps, capabilities, models };
  }

  const model = preferredModel?.trim() || models[0];
  if (!model) {
    skipRest(['chat', 'streaming', 'tools'], 'Choose a model to test against.');
    return { steps, capabilities, models };
  }
  capabilities.model = model;
  const messages = [{ role: 'user', content: 'Reply with the single word: ok' }];

  // 2 — a plain completion.
  try {
    const chat = await send(opts, 'POST', '/chat/completions', { model, messages, max_tokens: 16, stream: false });
    const choices = (parseJson(chat.body) as { choices?: unknown[] } | undefined)?.choices;
    if (chat.status >= 200 && chat.status < 300 && Array.isArray(choices) && choices.length > 0) {
      capabilities.chat = true;
      steps.push({ id: 'chat', status: 'pass', detail: `Completion returned by ${model}` });
    } else {
      steps.push({ id: 'chat', status: 'fail', detail: chat.status >= 400 ? reason(chat, opts.apiKey) : 'The response had no choices.' });
      skipRest(['streaming', 'tools'], 'Chat has to work first.');
      return { steps, capabilities, models };
    }
  } catch (error) {
    steps.push({ id: 'chat', status: 'fail', detail: networkReason(error) });
    skipRest(['streaming', 'tools'], 'Chat has to work first.');
    return { steps, capabilities, models };
  }

  // 3 — streaming, and whether token usage rides on it. A server that rejects
  // `stream_options` still streams; it just can't report usage that way.
  try {
    let streamed = await send(opts, 'POST', '/chat/completions', { model, messages, max_tokens: 16, stream: true, stream_options: { include_usage: true } });
    let usageRejected = false;
    if (streamed.status === 400 || streamed.status === 422) {
      usageRejected = true;
      streamed = await send(opts, 'POST', '/chat/completions', { model, messages, max_tokens: 16, stream: true });
    }
    const read = streamed.status >= 200 && streamed.status < 300 ? readStream(streamed.body) : { chunks: 0, usage: false };
    if (read.chunks > 0) {
      capabilities.streaming = true;
      capabilities.streamUsage = read.usage;
      steps.push({
        id: 'streaming',
        status: 'pass',
        detail: read.usage
          ? 'Streams, and reports token usage'
          : usageRejected
            ? 'Streams, but rejected the usage option — token counts will be missing'
            : 'Streams, but sent no token usage'
      });
    } else {
      steps.push({ id: 'streaming', status: 'fail', detail: streamed.status >= 400 ? reason(streamed, opts.apiKey) : 'No stream chunks arrived.' });
    }
  } catch (error) {
    steps.push({ id: 'streaming', status: 'fail', detail: networkReason(error) });
  }

  // 4 — tool calling, which agent sessions and workflows cannot work without.
  try {
    const toolReply = await send(opts, 'POST', '/chat/completions', {
      model,
      messages: [{ role: 'user', content: 'What time is it in UTC? Use the get_time tool; do not answer in text.' }],
      tools: [PROBE_TOOL],
      tool_choice: 'auto',
      max_tokens: 64,
      stream: false
    });
    const message = (parseJson(toolReply.body) as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: unknown } }> } }> } | undefined)
      ?.choices?.[0]?.message;
    const called = message?.tool_calls?.some(call => call.function?.name === 'get_time') === true;
    if (toolReply.status >= 200 && toolReply.status < 300 && called) {
      capabilities.tools = true;
      steps.push({ id: 'tools', status: 'pass', detail: 'Called the test tool' });
    } else {
      steps.push({
        id: 'tools',
        status: 'fail',
        detail: toolReply.status >= 400
          ? `${reason(toolReply, opts.apiKey)}. Agent sessions and workflows won't offer this endpoint.`
          : "The model answered in text instead of calling the tool. Agent sessions, ticket reviews and workflows won't offer this endpoint; AI recommendations still can."
      });
    }
  } catch (error) {
    steps.push({ id: 'tools', status: 'fail', detail: networkReason(error) });
  }

  return { steps, capabilities, models };
}
