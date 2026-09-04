import { createHash } from 'node:crypto';
import type { AiProvider } from '../../types';
import { fetchModels, type GatewayOptions, type RawGatewayModel } from '../gateway/gatewayClient';
import { fetchAnthropicModels } from './anthropicClient';

/**
 * One selectable model, shared by every "model picker" surface — both
 * `kind: 'api'` providers (this file, fetched from a real `/v1/models`-style
 * endpoint) and `kind: 'cli-agent'`/`hostKind: 'acp'` providers
 * (`AcpAgentHost.listAvailableModels`, fetched from ACP's `session/new`
 * `configOptions`). One shape, one picker UI on the frontend.
 */
export interface ModelChoice {
  value: string;
  name: string;
  description?: string;
  /**
   * The model's context window, when the provider's model listing reports one.
   * Used to tell a session how much room it has left; absent for CLI-hosted
   * agents and for gateways that do not publish it.
   */
  contextLength?: number;
}

export interface ModelOptions {
  currentValue?: string;
  options: ModelChoice[];
}

interface CacheEntry {
  choices: ModelChoice[];
  fetchedAt: number;
}

/**
 * In-memory catalog cache, mirroring frosty-extension's `providerCache.ts`/
 * `provider.ts`: no TTL and no polling — the key already embeds a hash of
 * the API key and the normalized URL, so a key or URL change is naturally a
 * cache miss with no explicit invalidation needed. Concurrent callers for
 * the same key join the same in-flight fetch instead of firing duplicates.
 * Callers opt into a fresh fetch (e.g. a "Refresh" button) via `forceRefresh`.
 */
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ModelChoice[]>>();

function cacheKey(provider: AiProvider, url: string, apiKey: string): string {
  const normalizedUrl = url.replace(/\/+$/, '').toLowerCase();
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  return `${provider}::${normalizedUrl}::${keyHash}`;
}

function normalize(raw: RawGatewayModel[]): ModelChoice[] {
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  for (const model of raw) {
    if (!model.id || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    out.push({
      value: model.id,
      name: model.name?.trim() || model.id,
      ...(typeof model.context_length === 'number' && model.context_length > 0
        ? { contextLength: model.context_length }
        : {})
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Fetches (or reuses the cached) model catalog for a `kind: 'api'` provider. */
export async function listCatalogModels(
  provider: AiProvider,
  opts: GatewayOptions,
  forceRefresh = false
): Promise<ModelChoice[]> {
  const key = cacheKey(provider, opts.url, opts.apiKey ?? '');
  if (!forceRefresh) {
    const cached = cache.get(key);
    if (cached) {
      return cached.choices;
    }
    const inFlight = pending.get(key);
    if (inFlight) {
      return inFlight;
    }
  }
  const promise = (async () => {
    // Anthropic's Models API needs `x-api-key`/`anthropic-version` auth, not
    // OpenAI-style Bearer — everything else speaks the same `/v1/models` shape.
    const raw = provider === 'anthropic' ? await fetchAnthropicModels(opts) : await fetchModels(opts);
    const choices = normalize(raw);
    cache.set(key, { choices, fetchedAt: Date.now() });
    return choices;
  })();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}
