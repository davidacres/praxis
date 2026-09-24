import { createHash } from 'node:crypto';
import type { AiProvider } from '../../types';
import { fetchModels, type GatewayOptions, type RawGatewayModel } from '../gateway/gatewayClient';
import { fetchAnthropicModels } from './anthropicClient';
import { fetchGeminiModels } from './geminiClient';
import { getKnownContextLength, getModelPricing, type ModelPriceRates } from './modelPricing';
import { findProviderDescriptor } from './registry';

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
  /** Model rates per million tokens in USD, when known. */
  pricing?: ModelPriceRates;
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

export const KNOWN_Z_AI_MODELS: readonly ModelChoice[] = [
  { value: 'glm-5.3', name: 'GLM-5.3 (Flagship Coding & Reasoning)', contextLength: 128000, pricing: { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4 } },
  { value: 'glm-5.3-flash', name: 'GLM-5.3 Flash (Fast Coding)', contextLength: 128000, pricing: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.5 } },
  { value: 'glm-4.5', name: 'GLM-4.5', contextLength: 128000, pricing: { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 } },
  { value: 'glm-4.5-flash', name: 'GLM-4.5 Flash', contextLength: 128000, pricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } },
  { value: 'glm-4-plus', name: 'GLM-4 Plus', contextLength: 128000 },
  { value: 'glm-4-flash', name: 'GLM-4 Flash', contextLength: 128000 },
  { value: 'glm-zero-preview', name: 'GLM Zero Preview', contextLength: 128000 }
];

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
    let raw: RawGatewayModel[] = [];
    // A custom endpoint may have no usable `/models`; its manually listed ids
    // stand in, and are merged in when the server lists some but not all.
    const descriptor = findProviderDescriptor(provider);
    const manual = (descriptor?.kind === 'api' ? descriptor.custom?.manualModels : undefined) ?? [];
    const manualChoices = (): ModelChoice[] => manual.map(id => ({ value: id, name: id }));
    try {
      raw = provider === 'anthropic'
        ? await fetchAnthropicModels(opts)
        : provider === 'gemini'
          ? await fetchGeminiModels(opts)
          : await fetchModels(opts);
    } catch (err) {
      if (provider === 'z-ai') {
        const fallbackChoices = [...KNOWN_Z_AI_MODELS];
        cache.set(key, { choices: fallbackChoices, fetchedAt: Date.now() });
        return fallbackChoices;
      }
      if (manual.length > 0) {
        const fallbackChoices = manualChoices();
        cache.set(key, { choices: fallbackChoices, fetchedAt: Date.now() });
        return fallbackChoices;
      }
      throw err;
    }
    let choices = normalize(raw);
    choices = choices.map(choice => {
      const pricing = getModelPricing(provider, choice.value);
      if (provider === 'z-ai') {
        const known = KNOWN_Z_AI_MODELS.find(k => k.value === choice.value);
        return {
          ...choice,
          contextLength: (typeof choice.contextLength === 'number' && choice.contextLength > 0)
            ? choice.contextLength
            : (known?.contextLength ?? 128000),
          ...(pricing || known?.pricing ? { pricing: pricing ?? known?.pricing } : {})
        };
      }
      return pricing ? { ...choice, pricing } : choice;
    });
    for (const extra of manualChoices()) {
      if (!choices.some(choice => choice.value === extra.value)) choices.push(extra);
    }
    if (provider === 'z-ai' && choices.length === 0) {
      const fallbackChoices = [...KNOWN_Z_AI_MODELS];
      cache.set(key, { choices: fallbackChoices, fetchedAt: Date.now() });
      return fallbackChoices;
    }
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
