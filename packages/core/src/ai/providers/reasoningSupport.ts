import type { AiProvider } from '../../types';
import { normalizeModelName } from './modelPricing';

/**
 * Normalized reasoning/thinking effort level. Each per-provider wire builder
 * translates this into its own request parameter — Anthropic's `thinking`
 * block, the OpenAI-compatible `reasoning_effort` string, or Gemini's
 * `generationConfig.thinkingConfig`. `'off'` means "don't ask for extra
 * reasoning," not "explicitly disable a model's own default behavior."
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

function isAnthropicReasoningModel(normalized: string): boolean {
  return (
    normalized.includes('claude') &&
    (normalized.includes('claude-3-7') ||
      normalized.includes('claude-3.7') ||
      /(^|-)(opus|sonnet|haiku)-[4-9]/.test(normalized))
  );
}

function isGeminiReasoningModel(normalized: string): boolean {
  return normalized.includes('gemini-2.5') || normalized.includes('gemini-3');
}

function isOpenAiReasoningModel(normalized: string): boolean {
  return /^o[134](-|$)/.test(normalized) || normalized.includes('gpt-5');
}

/**
 * Which real provider's reasoning parameter a model id needs, independent of
 * which connection is routing the request — a gateway/custom-endpoint model
 * id like `anthropic/claude-sonnet-4.6` still needs Anthropic's `thinking`
 * shape, not OpenAI's `reasoning_effort`, even though the HTTP request goes
 * to an OpenAI-compatible endpoint. Mirrors `shouldEnableVercelAutoCaching`'s
 * model-id sniffing in `gateway/wire.ts`.
 */
export function detectReasoningFamily(model: string | undefined): 'anthropic' | 'gemini' | 'openai' | undefined {
  if (!model) {
    return undefined;
  }
  const normalized = normalizeModelName(model);
  if (isAnthropicReasoningModel(normalized)) {
    return 'anthropic';
  }
  if (isGeminiReasoningModel(normalized)) {
    return 'gemini';
  }
  if (isOpenAiReasoningModel(normalized)) {
    return 'openai';
  }
  return undefined;
}

/** Every selectable provider model may have a reasoning default. Direct
 * provider adapters translate the normalized value, OpenAI-compatible
 * endpoints receive `reasoning_effort`, and ACP agents consume their
 * advertised `thought_level` option. The model family only selects the wire
 * shape; it must not hide the UI for new, aliased, or provider-specific ids. */
export function supportsReasoningEffort(provider: AiProvider | undefined, _model: string | undefined): boolean {
  return Boolean(provider);
}

const THINKING_BUDGET_TOKENS: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192
};

/** Anthropic `thinking.budget_tokens` for a level, or `undefined` for `'off'`. */
export function anthropicThinkingBudget(level: ReasoningEffort | undefined): number | undefined {
  if (!level || level === 'off') {
    return undefined;
  }
  return THINKING_BUDGET_TOKENS[level];
}

/** Gemini `generationConfig.thinkingConfig.thinkingBudget` for a level, or `undefined` for `'off'`. */
export function geminiThinkingBudget(level: ReasoningEffort | undefined): number | undefined {
  if (!level || level === 'off') {
    return undefined;
  }
  return THINKING_BUDGET_TOKENS[level];
}
