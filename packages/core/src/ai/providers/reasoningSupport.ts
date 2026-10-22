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

/**
 * Anthropic ships two mutually-exclusive thinking modes, and which one a model
 * accepts is decided by its generation, not by anything in the response:
 *
 * - `extended` — `thinking: {type: 'enabled', budget_tokens: N}`. The only
 *   mode on Claude 4.5 and earlier; deprecated but still accepted on 4.6.
 * - `adaptive` — `thinking: {type: 'adaptive'}` plus `output_config: {effort}`.
 *   Required by Claude 4.7 and later, which reject `type: 'enabled'` with a
 *   400 error.
 *
 * Sending the wrong one is a hard request failure, so the mode is derived from
 * the model id rather than probed. See `docs/research/model-reasoning-response-shapes.md` §F5.
 */
export type AnthropicThinkingMode = 'adaptive' | 'extended';

/** Aliases with no numeric generation in the id. Every one is a 5.x model. */
const ADAPTIVE_CLAUDE_ALIASES = ['fable', 'mythos'] as const;

/** `major[.minor]` from a Claude id, or undefined when it carries no digits. */
function claudeGeneration(normalized: string): { major: number; minor: number } | undefined {
  const match = normalized.match(/(\d+)(?:[.\-](\d+))?/);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
}

/**
 * Which thinking mode a Claude model id needs, or `undefined` when the id
 * cannot be placed on Anthropic's compatibility table (a custom alias, a
 * future name). Callers omit the `thinking` parameter entirely in that case,
 * which is always accepted — 5.x models think by default, and 4.x ones simply
 * don't.
 */
export function anthropicThinkingMode(model: string | undefined): AnthropicThinkingMode | undefined {
  if (!model) {
    return undefined;
  }
  const normalized = normalizeModelName(model);
  if (!normalized.includes('claude')) {
    return undefined;
  }
  const generation = claudeGeneration(normalized);
  if (!generation) {
    return ADAPTIVE_CLAUDE_ALIASES.some(alias => normalized.includes(alias)) ? 'adaptive' : undefined;
  }
  // 4.6 accepts both modes; Anthropic recommends adaptive, so prefer it.
  if (generation.major >= 5 || (generation.major === 4 && generation.minor >= 6)) {
    return 'adaptive';
  }
  return 'extended';
}

function isAnthropicReasoningModel(normalized: string): boolean {
  if (!normalized.includes('claude')) {
    return false;
  }
  return (
    normalized.includes('claude-3-7') ||
    normalized.includes('claude-3.7') ||
    /(^|-)(opus|sonnet|haiku)-[3-9]/.test(normalized) ||
    ADAPTIVE_CLAUDE_ALIASES.some(alias => normalized.includes(alias))
  );
}

function isGeminiReasoningModel(normalized: string): boolean {
  return normalized.includes('gemini-2.5') || normalized.includes('gemini-3');
}

function isOpenAiReasoningModel(normalized: string): boolean {
  return /^o[134](-|$)/.test(normalized) || normalized.includes('gpt-5') || normalized.includes('gpt-6');
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

/**
 * The Anthropic `thinking` request configuration for a model and effort level,
 * in whichever mode that model accepts. `undefined` means "send no `thinking`
 * parameter at all" — the right answer for `'off'`, and for a model whose
 * generation cannot be determined.
 *
 * Adaptive mode also carries `output_config`, and always asks for
 * `display: 'summarized'`: on Claude 4.7+ `display` defaults to `'omitted'`,
 * which returns thinking blocks with an empty `thinking` field. Without it the
 * request succeeds, the reasoning tokens are billed, and the chat pane shows
 * nothing — the failure mode is silent.
 *
 * `'off'` returns `undefined` in both modes, matching `ReasoningEffort`'s
 * contract of "don't ask for extra reasoning." That matters beyond tidiness:
 * Claude 4.6–4.8 default to thinking *off*, so sending them a `thinking`
 * parameter at `'off'` would silently switch reasoning on. Reasoning stays
 * opt-in, exactly as it was before the mode split.
 */
export function anthropicThinkingConfig(
  model: string | undefined,
  level: ReasoningEffort | undefined
): { thinking?: Record<string, unknown>; outputConfig?: Record<string, unknown> } | undefined {
  if (!level || level === 'off') {
    return undefined;
  }
  const mode = anthropicThinkingMode(model);
  if (!mode) {
    return undefined;
  }
  if (mode === 'extended') {
    const budget = anthropicThinkingBudget(level);
    if (!budget) {
      return undefined;
    }
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  // Adaptive: depth is steered by `effort`, not a token budget.
  return { thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: level } };
}

/** Gemini `generationConfig.thinkingConfig.thinkingBudget` for a level, or `undefined` for `'off'`. */
export function geminiThinkingBudget(level: ReasoningEffort | undefined): number | undefined {
  if (!level || level === 'off') {
    return undefined;
  }
  return THINKING_BUDGET_TOKENS[level];
}

/** Providers whose ACP host relays the model's thinking as content. */
const ACP_REASONING_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  'claude-code-cli',
  'codex-cli',
  'copilot-cli',
  'antigravity-cli',
  'cursor-cli'
]);

/**
 * Whether a session's turns can produce reasoning *text* to display, and if not
 * why. Absent reasoning is a normal outcome rather than a failure, so the UI
 * names the case instead of rendering a blank — see `ThoughtBlock`.
 *
 * - `'text'` — the route returns readable reasoning; show it.
 * - `'opaque'` — the model reasons but this route never returns the text.
 * - `'not-requested'` — the session asked for no reasoning (`effort: 'off'`).
 *
 * The model id alone cannot decide this: `gpt-6-luna` yields reasoning through
 * `codex-cli` and none through `openai`, because OpenAI's HTTP API keeps
 * reasoning items opaque and returns only their token count. The provider —
 * i.e. the route — is what distinguishes them.
 */
export type ReasoningAvailability = 'text' | 'opaque' | 'not-requested';

export function reasoningAvailability(
  provider: AiProvider | undefined,
  model: string | undefined,
  effort: ReasoningEffort | undefined
): ReasoningAvailability {
  // A CLI agent relays thinking as content, whatever model it is driving.
  if (provider && ACP_REASONING_PROVIDERS.has(provider)) {
    return 'text';
  }
  // Only an explicit 'off' opts out. `undefined` is not "no reasoning": the
  // hosts resolve it to the provider's per-model default and then to 'medium'
  // (`vercelAgentService.ts`, `acpAgentHost.ts`), so thinking is requested.
  if (effort === 'off') {
    return 'not-requested';
  }
  // OpenAI's own HTTP endpoint never returns reasoning text for its reasoning
  // models — only `completion_tokens_details.reasoning_tokens`. That count is
  // why the telemetry bar can still say thinking happened.
  if (provider === 'openai' && detectReasoningFamily(model) === 'openai') {
    return 'opaque';
  }
  return 'text';
}
