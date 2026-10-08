import type { AiProvider } from '../../types';
import type { TokenUsage } from '../gateway/wire';

/**
 * Static USD-per-million-token rates for providers whose chat API reports
 * only token counts, never a monetary cost — unlike ACP CLI agents, which
 * report cumulative cost directly (see `AgentSessionRecord.cost`'s doc).
 * There is no billing API to read these from; they are transcribed from
 * https://docs.z.ai/guides/overview/pricing and need re-checking there if
 * Z.ai's price list changes. Free-tier models are listed explicitly with
 * zero rates rather than omitted, so a lookup miss always means "unpriced",
 * never "free".
 */
export interface ModelPriceRates {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const ZAI_MODEL_PRICING: Record<string, ModelPriceRates> = {
  'glm-5.3-flash': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.5 },
  'glm-5.3-flashx': { inputPerMillionUsd: 0.37, outputPerMillionUsd: 1.25 },
  'glm-5.3': { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4 },
  'glm-5.2': { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4 },
  'glm-5.1': { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4 },
  'glm-5': { inputPerMillionUsd: 1.0, outputPerMillionUsd: 3.2 },
  'glm-4.7': { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 },
  'glm-4.7-flashx': { inputPerMillionUsd: 0.07, outputPerMillionUsd: 0.4 },
  'glm-4.7-flash': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'glm-4.6': { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 },
  'glm-4.5': { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 },
  'glm-4.5-x': { inputPerMillionUsd: 2.2, outputPerMillionUsd: 8.9 },
  'glm-4.5-air': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.1 },
  'glm-4.5-airx': { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.5 },
  'glm-4.5-flash': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'glm-4-32b-0414-128k': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.1 },
  'glm-4.6v': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 0.9 },
  'glm-4.6v-flashx': { inputPerMillionUsd: 0.04, outputPerMillionUsd: 0.4 },
  'glm-4.6v-flash': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'glm-4.5v': { inputPerMillionUsd: 0.6, outputPerMillionUsd: 1.8 },
  'glm-ocr': { inputPerMillionUsd: 0.03, outputPerMillionUsd: 0.03 }
};

const OPENAI_MODEL_PRICING: Record<string, ModelPriceRates> = {
  'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4o-2024-08-06': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4o-2024-11-20': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'gpt-4o-mini-2024-07-18': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'o1': { inputPerMillionUsd: 15, outputPerMillionUsd: 60 },
  'o1-2024-12-17': { inputPerMillionUsd: 15, outputPerMillionUsd: 60 },
  'o1-preview': { inputPerMillionUsd: 15, outputPerMillionUsd: 60 },
  'o1-mini': { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 },
  'o3-mini': { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 },
  'o3': { inputPerMillionUsd: 10, outputPerMillionUsd: 40 },
  'gpt-4.5-preview': { inputPerMillionUsd: 75, outputPerMillionUsd: 150 },
  'gpt-4-turbo': { inputPerMillionUsd: 10, outputPerMillionUsd: 30 },
  'gpt-4-turbo-2024-04-09': { inputPerMillionUsd: 10, outputPerMillionUsd: 30 },
  'gpt-4': { inputPerMillionUsd: 30, outputPerMillionUsd: 60 },
  'gpt-3.5-turbo': { inputPerMillionUsd: 0.5, outputPerMillionUsd: 1.5 },
  'chatgpt-4o-latest': { inputPerMillionUsd: 5, outputPerMillionUsd: 15 }
};

const ANTHROPIC_MODEL_PRICING: Record<string, ModelPriceRates> = {
  'claude-3-7-sonnet-20250219': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-7-sonnet': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3.7-sonnet': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-7-sonnet-latest': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-5-sonnet-20241022': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-5-sonnet-20240620': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-5-sonnet': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3.5-sonnet': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-3-5-sonnet-latest': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-sonnet-4-6': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-sonnet-4.6': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-haiku-5-5': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
  'claude-haiku-5.5': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
  'claude-3-5-haiku-20241022': { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  'claude-3-5-haiku': { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  'claude-3.5-haiku': { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  'claude-3-5-haiku-latest': { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  'claude-3-haiku-20240307': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.25 },
  'claude-3-haiku': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.25 },
  'claude-3-opus-20240229': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-3-opus': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-3-opus-latest': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-opus-4-6': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-opus-4.6': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 }
};

const GEMINI_MODEL_PRICING: Record<string, ModelPriceRates> = {
  'gemini-2.5-pro': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  'gemini-2.5-pro-latest': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  'gemini-2.5-flash': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-2.5-flash-latest': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-2.0-flash': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'gemini-2.0-flash-001': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'gemini-2.0-flash-exp': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'gemini-2.0-flash-lite': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-2.0-flash-lite-001': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-2.0-flash-lite-preview-02-05': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-1.5-pro': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  'gemini-1.5-pro-002': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  'gemini-1.5-pro-latest': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
  'gemini-1.5-flash': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-1.5-flash-002': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-1.5-flash-latest': { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  'gemini-1.5-flash-8b': { inputPerMillionUsd: 0.0375, outputPerMillionUsd: 0.15 },
  'gemini-1.5-flash-8b-latest': { inputPerMillionUsd: 0.0375, outputPerMillionUsd: 0.15 }
};

const PRICING_BY_PROVIDER: Partial<Record<AiProvider, Record<string, ModelPriceRates>>> = {
  'z-ai': ZAI_MODEL_PRICING,
  openai: OPENAI_MODEL_PRICING,
  anthropic: ANTHROPIC_MODEL_PRICING,
  gemini: GEMINI_MODEL_PRICING
};

export function normalizeModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/^(openai|anthropic|google|models|vercel|meta)\//, '');
}

export function getKnownContextLength(
  model: string | undefined,
  _provider?: AiProvider
): number | undefined {
  if (!model) {
    return undefined;
  }
  const normalized = normalizeModelName(model);

  if (normalized.startsWith('glm-')) {
    return 128000;
  }
  if (
    normalized.startsWith('claude-haiku-5') ||
    normalized.includes('haiku-5') ||
    normalized === 'haiku'
  ) {
    return 1000000;
  }
  if (
    normalized.startsWith('claude-3') ||
    normalized.startsWith('claude-2') ||
    normalized.startsWith('claude-sonnet') ||
    normalized.startsWith('claude-opus') ||
    normalized.startsWith('claude-haiku') ||
    normalized.includes('sonnet') ||
    normalized.includes('opus') ||
    normalized.includes('haiku')
  ) {
    return 200000;
  }
  if (normalized.startsWith('gemini-') || normalized.includes('gemini')) {
    if (normalized.includes('pro')) {
      return 2097152;
    }
    return 1048576;
  }
  if (normalized.startsWith('o1-mini') || normalized.startsWith('o1-preview')) {
    return 128000;
  }
  if (normalized.startsWith('o1') || normalized.startsWith('o3')) {
    return 200000;
  }
  if (
    normalized.startsWith('gpt-4o') ||
    normalized.startsWith('chatgpt-4o') ||
    normalized.startsWith('gpt-4.5') ||
    normalized.startsWith('gpt-4-turbo')
  ) {
    return 128000;
  }
  if (normalized.startsWith('gpt-4-32k')) {
    return 32768;
  }
  if (normalized === 'gpt-4' || normalized.startsWith('gpt-4-')) {
    return 8192;
  }
  if (normalized.startsWith('gpt-3.5')) {
    return 16385;
  }
  if (normalized.includes('deepseek')) {
    return 128000;
  }
  return undefined;
}

export function getModelPricing(
  provider: AiProvider | undefined,
  model: string | undefined
): ModelPriceRates | undefined {
  if (!model) {
    return undefined;
  }
  const raw = model.trim().toLowerCase();
  const normalized = normalizeModelName(model);

  // 1. Direct provider map lookup
  if (provider && PRICING_BY_PROVIDER[provider]) {
    const table = PRICING_BY_PROVIDER[provider]!;
    if (table[raw]) return table[raw];
    if (table[normalized]) return table[normalized];
  }

  // 2. Cross-provider lookup across all tables
  if (ZAI_MODEL_PRICING[raw] || ZAI_MODEL_PRICING[normalized]) {
    return ZAI_MODEL_PRICING[raw] ?? ZAI_MODEL_PRICING[normalized];
  }
  if (OPENAI_MODEL_PRICING[raw] || OPENAI_MODEL_PRICING[normalized]) {
    return OPENAI_MODEL_PRICING[raw] ?? OPENAI_MODEL_PRICING[normalized];
  }
  if (ANTHROPIC_MODEL_PRICING[raw] || ANTHROPIC_MODEL_PRICING[normalized]) {
    return ANTHROPIC_MODEL_PRICING[raw] ?? ANTHROPIC_MODEL_PRICING[normalized];
  }
  if (GEMINI_MODEL_PRICING[raw] || GEMINI_MODEL_PRICING[normalized]) {
    return GEMINI_MODEL_PRICING[raw] ?? GEMINI_MODEL_PRICING[normalized];
  }

  // 3. Heuristic / prefix matching
  if (normalized.includes('sonnet')) {
    return ANTHROPIC_MODEL_PRICING['claude-3-5-sonnet'];
  }
  if (
    normalized.includes('haiku-5.5') ||
    normalized.includes('5-5-haiku') ||
    normalized.includes('5.5-haiku') ||
    normalized.includes('haiku-5') ||
    normalized === 'haiku'
  ) {
    return ANTHROPIC_MODEL_PRICING['claude-haiku-5-5'];
  }
  if (normalized.includes('haiku-3.5') || normalized.includes('3-5-haiku') || normalized.includes('3.5-haiku')) {
    return ANTHROPIC_MODEL_PRICING['claude-3-5-haiku'];
  }
  if (normalized.includes('haiku')) {
    return ANTHROPIC_MODEL_PRICING['claude-3-haiku'];
  }
  if (normalized.includes('opus')) {
    return ANTHROPIC_MODEL_PRICING['claude-3-opus'];
  }
  if (normalized.startsWith('gpt-4o-mini')) {
    return OPENAI_MODEL_PRICING['gpt-4o-mini'];
  }
  if (normalized.startsWith('gpt-4o') || normalized.startsWith('chatgpt-4o')) {
    return OPENAI_MODEL_PRICING['gpt-4o'];
  }
  if (normalized.startsWith('o1-mini')) {
    return OPENAI_MODEL_PRICING['o1-mini'];
  }
  if (normalized.startsWith('o3-mini')) {
    return OPENAI_MODEL_PRICING['o3-mini'];
  }
  if (normalized.startsWith('o1-preview')) {
    return OPENAI_MODEL_PRICING['o1-preview'];
  }
  if (normalized.startsWith('o1')) {
    return OPENAI_MODEL_PRICING['o1'];
  }
  if (normalized.startsWith('o3')) {
    return OPENAI_MODEL_PRICING['o3'];
  }
  if (normalized.startsWith('gpt-4.5')) {
    return OPENAI_MODEL_PRICING['gpt-4.5-preview'];
  }
  if (normalized.startsWith('gpt-4-turbo')) {
    return OPENAI_MODEL_PRICING['gpt-4-turbo'];
  }
  if (normalized.startsWith('gpt-3.5')) {
    return OPENAI_MODEL_PRICING['gpt-3.5-turbo'];
  }
  if (normalized.startsWith('gpt-4')) {
    return OPENAI_MODEL_PRICING['gpt-4'];
  }
  if (normalized.startsWith('gemini-') || normalized.includes('gemini')) {
    if (normalized.includes('flash-8b')) return GEMINI_MODEL_PRICING['gemini-1.5-flash-8b'];
    if (normalized.includes('flash-lite')) return GEMINI_MODEL_PRICING['gemini-2.0-flash-lite'];
    if (normalized.includes('flash')) return GEMINI_MODEL_PRICING['gemini-2.5-flash'];
    if (normalized.includes('pro')) return GEMINI_MODEL_PRICING['gemini-2.5-pro'];
  }
  if (normalized.startsWith('glm-')) {
    if (normalized.startsWith('glm-5.3-flash')) return ZAI_MODEL_PRICING['glm-5.3-flash'];
    if (normalized.startsWith('glm-5')) return ZAI_MODEL_PRICING['glm-5'];
    if (normalized.startsWith('glm-4.7-flash')) return ZAI_MODEL_PRICING['glm-4.7-flash'];
    if (normalized.startsWith('glm-4')) return ZAI_MODEL_PRICING['glm-4.5'];
  }

  return undefined;
}

const ESTIMATED_USAGE_PRICING: Partial<Record<AiProvider, Record<string, ModelPriceRates>>> = {
  'z-ai': ZAI_MODEL_PRICING
};

/**
 * USD cost of one usage delta, or `undefined` when the provider/model has no
 * maintained rate — callers must treat that as "unknown", not zero, so an
 * unpriced model doesn't silently read as free against a spend limit.
 */
export function estimateCostUsd(
  provider: AiProvider | undefined,
  model: string | undefined,
  usage: TokenUsage
): { amount: number; currency: string } | undefined {
  if (!provider || !model) {
    return undefined;
  }
  const rates = ESTIMATED_USAGE_PRICING[provider]?.[model.trim().toLowerCase()];
  if (!rates) {
    return undefined;
  }
  const amount =
    ((usage.inputTokens ?? 0) / 1_000_000) * rates.inputPerMillionUsd +
    ((usage.outputTokens ?? 0) / 1_000_000) * rates.outputPerMillionUsd;
  return { amount, currency: 'USD' };
}

/**
 * Estimated USD cost of a turn using rates across all supported providers
 * (OpenAI, Anthropic, Gemini, Z.ai, Vercel AI Gateway).
 */
export function estimateTurnCost(
  provider: AiProvider | undefined,
  model: string | undefined,
  usage: TokenUsage
): { amount: number; currency: string } | undefined {
  if (!model) {
    return undefined;
  }
  const rates = getModelPricing(provider, model);
  if (!rates) {
    return undefined;
  }
  const amount =
    ((usage.inputTokens ?? 0) / 1_000_000) * rates.inputPerMillionUsd +
    ((usage.outputTokens ?? 0) / 1_000_000) * rates.outputPerMillionUsd;
  return { amount, currency: 'USD' };
}
