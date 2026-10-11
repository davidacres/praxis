import { spawn, execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AiProvider } from '../../types';
import type { ModelChoice } from './modelCatalog';
import { PROCESS_GROUPS_SUPPORTED, stopProcessGroup } from '../tools/processTree';

export type CliModelMetadata = Pick<ModelChoice, 'contextLength' | 'pricingLabel' | 'contextLabel'>;

const execFileAsync = promisify(execFile);

/** Canonical model family id, excluding CLI reasoning/speed parameters. */
export function canonicalCliModelId(value: string): string {
  return value.toLowerCase().split('[')[0].replace(/\s*\([^)]*\)/g, '').trim()
    .replace(/\s+/g, '-').replace(/-(?:thinking|extra-high|xhigh|high|medium|low|minimal|none|max|fast)(?=-|$)/g, '')
    .replace(/^(opus|sonnet|haiku|fable)-/, 'claude-$1-')
    .replace(/^(claude-(?:opus|sonnet|haiku|fable)-\d+)-(\d+)(?=-|$)/, '$1.$2')
    .replace(/-\d{8}$/, '').replace(/^glm-5p3/, 'glm-5.3');
}

/** Published base token rates, checked 2026-10-11. These are API references,
 * not charges against a CLI subscription. Exact ids only; no family guesses.
 * https://developers.openai.com/api/docs/pricing
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://ai.google.dev/gemini-api/docs/pricing
 * https://cursor.com/docs/models-and-pricing
 */
const REFERENCE_RATES: Record<string, [number, number]> = {
  'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50], 'gpt-6-sol': [2, 10], 'gpt-6-luna': [0.1, 0.5],
  'gpt-5.6-sol': [4, 20], 'gpt-5.6-terra': [2, 12], 'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.5': [5, 30], 'gpt-5.4': [2.5, 15], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.3-codex': [1.75, 14], 'gpt-5.2': [1.75, 14], 'gpt-5.1': [1.25, 10], 'gpt-5-mini': [0.25, 2],
  'claude-opus-5.5': [4, 20], 'claude-sonnet-5.5': [2, 10], 'claude-haiku-5.5': [0.1, 0.5],
  'claude-fable-5.1': [10, 50], 'claude-fable-5': [10, 50], 'claude-opus-5': [5, 25],
  'claude-opus-4.8': [5, 25], 'claude-opus-4.7': [5, 25], 'claude-opus-4.6': [5, 25], 'claude-opus-4.5': [5, 25],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4.6': [3, 15], 'claude-sonnet-4.5': [3, 15], 'claude-sonnet-4': [3, 15], 'claude-haiku-4.5': [1, 5],
  'gemini-3.8-flash': [0.75, 3.75], 'gemini-3.7-flash': [0.75, 3.75], 'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.1-pro': [2, 12], 'muse-spark-1.3': [1.25, 4.25],
  'kimi-k3': [3, 15], 'glm-5.2': [1.4, 4.4], 'glm-5.3': [1.4, 4.4], 'glm-5.3-flash': [0.15, 0.5],
  'kimi-k2.7-code': [0.95, 4], 'gemini-3.5-flash': [1.5, 9], 'gemini-3-flash': [0.5, 3], 'gemini-2.5-flash': [0.3, 2.5],
};

// Defaults documented by Cursor's model pages. Explicit ACP context parameters
// and native catalog limits always win over these defaults.
const CURSOR_DEFAULT_CONTEXTS: Record<string, number> = {
  'grok-4.7': 256000, 'grok-4.6': 256000, 'grok-4.5': 256000, 'composer-2.5': 200000,
  'gemini-3.8-flash': 200000, 'muse-spark-1.3': 300000,
};

export function publishedCliModelMetadata(provider: AiProvider, choice: ModelChoice): CliModelMetadata {
  const id = canonicalCliModelId(choice.value);
  const nameId = canonicalCliModelId(choice.name);
  const resolved = Object.hasOwn(REFERENCE_RATES, id) ? id : nameId;
  const rates = Object.hasOwn(REFERENCE_RATES, resolved) ? REFERENCE_RATES[resolved] : undefined;
  const metadata: CliModelMetadata = {};
  if (rates) metadata.pricingLabel = `API base $${rates[0]} / $${rates[1]} /1M`;
  if (/^claude-(?:opus|sonnet|haiku|fable)-5(?:\.|$)/.test(resolved)) metadata.contextLength = 1_000_000;
  if (/^gemini-3\.[678]-flash$/.test(resolved)) metadata.contextLength = 1048576;
  if (provider === 'cursor-cli') {
    metadata.contextLength = Object.hasOwn(CURSOR_DEFAULT_CONTEXTS, id) ? CURSOR_DEFAULT_CONTEXTS[id] : undefined;
    if (id.startsWith('grok-4.') || id === 'composer-2.5') {
      const fast = /\bfast=true\b/.test(choice.value);
      const long = id === 'grok-4.7' && /\bcontext=500k\b/.test(choice.value);
      const input = id === 'composer-2.5' ? (fast ? 3 : 0.5) : (long && fast ? 6 : long || fast ? 4 : 2);
      const output = id === 'composer-2.5' ? (fast ? 15 : 2.5) : ((long && fast) || (fast && id === 'grok-4.5') ? 18 : long || fast ? 12 : 6);
      metadata.pricingLabel = `$${input} / $${output} /1M`;
    }
    if (id === 'gemini-3.8-flash') metadata.pricingLabel = '$0.75 / $3.5 /1M';
  } else if (provider === 'antigravity-cli') {
    // Published model windows: Gemini 3 and Claude 5.5 expose 1M. GPT-OSS
    // is an open-weight model with a 131,072-token context, not a token-priced API.
    if (/^gemini-3\.(?:1-pro|[678]-flash)$/.test(id)) metadata.contextLength = 1048576;
    if (/^claude-(?:opus|sonnet)-5\.5$/.test(id)) metadata.contextLength = 1_000_000;
    if (id === 'gpt-oss-120b') { metadata.contextLength = 131072; metadata.pricingLabel = 'Open weights'; }
  }
  if (id === 'auto' || (id === 'default' && choice.name.toLowerCase() === 'auto')) {
    metadata.contextLabel = 'Model dependent'; metadata.pricingLabel = 'Routed model rate';
  }
  return metadata;
}

/** Cursor's catalog includes context sizes in tooltip metadata even when the
 * ACP variant omits a context parameter. Match aliases/variants by canonical id. */
export function cursorModelMetadata(result: unknown): Map<string, CliModelMetadata> {
  const metadata = new Map<string, CliModelMetadata>();
  const models = (result as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(models)) return metadata;
  for (const item of models) {
    const model = item as { name?: string; contextTokenLimit?: number; tooltipData?: { markdownContent?: string }; legacySlugs?: string[]; idAliases?: string[] };
    if (typeof model?.name !== 'string') continue;
    const match = model.tooltipData?.markdownContent?.match(/([\d,.]+)\s*([km])\s*(?:token\s+)?context\s+window/i);
    const size = model.contextTokenLimit ?? (match ? Number(match[1].replace(/,/g, '')) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1000) : undefined);
    if (!Number.isSafeInteger(size) || size! <= 0) continue;
    for (const id of [model.name, ...(model.legacySlugs ?? []), ...(model.idAliases ?? [])]) {
      const key = canonicalCliModelId(id);
      // Conflicting context variants must be resolved by the explicit ACP id.
      const existing = metadata.get(key)?.contextLength;
      if (!existing || size! < existing) metadata.set(key, { contextLength: size });
    }
  }
  return metadata;
}

async function readCursorModelMetadata(): Promise<Map<string, CliModelMetadata>> {
  if (process.env.CURSOR_API_ENDPOINT && new URL(process.env.CURSOR_API_ENDPOINT).origin !== 'https://api2.cursor.sh') return new Map();
  let token = process.env.CURSOR_API_KEY;
  if (!token && process.platform === 'darwin') {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'], { timeout: 3000, maxBuffer: 16384 });
    token = stdout.trim();
  } else if (!token) {
    const folder = process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor');
    const auth = JSON.parse(await readFile(join(folder, 'auth.json'), 'utf8'));
    token = auth.apiKey || auth.accessToken;
  }
  if (!token) return new Map();
  // Credentials from the Cursor store are only sent to Cursor's own endpoint.
  const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ useModelParameters: true, doNotUseMarkdown: true }), signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`Cursor model catalog returned ${response.status}.`);
  return cursorModelMetadata(await response.json());
}

/** Copilot's native catalog uses AI credits, not USD. Keep the billing unit intact. */
export function copilotModelMetadata(result: unknown): Map<string, CliModelMetadata> {
  const metadata = new Map<string, CliModelMetadata>();
  const models = (result as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(models)) return metadata;
  for (const item of models) {
    const model = item as { id?: string; capabilities?: { limits?: { max_context_window_tokens?: number } }; billing?: {
      discountPercent?: number; multiplier?: number;
      tokenPrices?: { inputPrice?: number; outputPrice?: number; batchSize?: number };
    } };
    if (typeof model?.id !== 'string') continue;
    const context = model.capabilities?.limits?.max_context_window_tokens;
    const prices = model.billing?.tokenPrices;
    const entry: CliModelMetadata = {};
    if (Number.isSafeInteger(context) && context! > 0) entry.contextLength = context;
    if (prices && typeof prices.inputPrice === 'number' && Number.isFinite(prices.inputPrice) && prices.inputPrice >= 0 &&
      typeof prices.outputPrice === 'number' && Number.isFinite(prices.outputPrice) && prices.outputPrice >= 0 &&
      typeof prices.batchSize === 'number' && Number.isFinite(prices.batchSize) && prices.batchSize > 0) {
      const scale = 1_000_000 / prices.batchSize;
      const input = prices.inputPrice * scale;
      const output = prices.outputPrice * scale;
      if (Number.isFinite(input) && Number.isFinite(output)) entry.pricingLabel = `${Number(input.toPrecision(6))} / ${Number(output.toPrecision(6))} credits/1M`;
    } else if (typeof model.billing?.multiplier === 'number' && Number.isFinite(model.billing.multiplier) && model.billing.multiplier >= 0) {
      entry.pricingLabel = `${model.billing.multiplier}× premium requests`;
    }
    if (model.id === 'auto') {
      entry.contextLabel = 'Model dependent';
      const discount = model.billing?.discountPercent;
      entry.pricingLabel = typeof discount === 'number' && discount > 0 && discount <= 100 ? `Routed rate −${discount}%` : 'Routed model rate';
    }
    metadata.set(model.id, entry);
  }
  return metadata;
}

/** Read-only native catalog probes. No session prompt or completion is sent. */
export async function readNativeCliModelMetadata(provider: AiProvider, command: string, prefixArgs: string[] = []): Promise<Map<string, CliModelMetadata>> {
  if (provider === 'cursor-cli') return readCursorModelMetadata();
  if (provider !== 'copilot-cli' && provider !== 'claude-code-cli') return new Map();
  return new Promise((resolve, reject) => {
    const copilot = provider === 'copilot-cli';
    const child = spawn(command, [...prefixArgs, ...(copilot ? ['--server', '--stdio'] : [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
    ])], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...(PROCESS_GROUPS_SUPPORTED ? { detached: true } : {}) });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let models: Array<{ value: string; resolvedModel?: string; displayName?: string }> = [];
    let modelIndex = 0;
    const metadata = new Map<string, CliModelMetadata>();
    const finish = (error?: Error, result = metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      const stopped = PROCESS_GROUPS_SUPPORTED && child.pid ? stopProcessGroup(child.pid, 300) : Promise.resolve(child.kill());
      void stopped.then(() => { if (error) reject(error); else resolve(result); }, () => { if (error) reject(error); else resolve(result); });
    };
    const timer = setTimeout(() => finish(new Error('Native model catalog timed out.')), 15000);
    child.once('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.stdout.on('error', error => finish(error));
    child.once('exit', () => finish(new Error('Native model catalog exited before answering.')));
    const send = (id: string, request: Record<string, unknown>) => {
      const json = JSON.stringify({ type: 'control_request', request_id: id, request });
      child.stdin.write(`${json}\n`);
    };
    const nextModel = () => {
      if (++modelIndex < models.length) send('model', { subtype: 'set_model', model: models[modelIndex].value });
      else finish();
    };
    const handle = (message: any) => {
      if (copilot) {
        if (message.id !== 1) return;
        if (message.error) finish(new Error(message.error.message));
        else finish(undefined, copilotModelMetadata(message.result));
        return;
      }
      if (message.type !== 'control_response') return;
      const response = message.response;
      if (response?.subtype === 'error') {
        // Some listed models are entitlement-gated. Keep the authoritative
        // results already read and continue checking the rest of the catalog.
        if (response.request_id === 'model' || response.request_id === 'context') nextModel();
        else finish(new Error(response.error));
        return;
      }
      if (response?.request_id === 'init') {
        models = (response.response?.models ?? []).filter((model: any) => typeof model?.value === 'string');
        if (!models.length) { finish(); return; }
        for (const model of models) metadata.set(model.value, publishedCliModelMetadata(provider, {
          value: model.resolvedModel ?? model.value, name: model.displayName ?? model.value
        }));
        send('model', { subtype: 'set_model', model: models[0].value });
      } else if (response?.request_id === 'model') {
        send('context', { subtype: 'get_context_usage', detail: 'summary' });
      } else if (response?.request_id === 'context') {
        const size = response.response?.rawMaxTokens;
        if (Number.isSafeInteger(size) && size > 0) metadata.set(models[modelIndex].value, { ...metadata.get(models[modelIndex].value), contextLength: size });
        nextModel();
      }
    };
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8 * 1024 * 1024) { finish(new Error('Native model catalog exceeded size limit.')); return; }
      try {
        while (!settled) {
          if (copilot) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) break;
            const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
            if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error('Invalid native model catalog frame.');
            if (buffer.length < headerEnd + 4 + length) break;
            const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
            buffer = buffer.subarray(headerEnd + 4 + length);
            handle(JSON.parse(body.toString()));
          } else {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.subarray(0, newline).toString();
            buffer = buffer.subarray(newline + 1);
            if (line.trim()) handle(JSON.parse(line));
          }
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    if (copilot) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'models.list', params: {} });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else send('init', { subtype: 'initialize' });
  });
}
