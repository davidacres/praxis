import type { AgentEventSummary, AgentSessionRecord, AiProvider, Connection } from '@praxis/core';
import { isTerminalAgentState } from './aiSessionState';
import { providerLabel } from './modelProviders';

/**
 * Naming and classification for an agent session, shared by the three surfaces
 * that show one: the sidebar tree, the console, and the right-pane inspector.
 *
 * These were private to `SessionsPage` while it owned its own list column. The
 * list now lives in the shell's sidebar, so they are shared rather than
 * duplicated.
 */

export function sessionTitle(session: AgentSessionRecord): string {
  return session.title?.trim() || session.taskDefinition.goal.split('\n')[0];
}
/**
 * A free-form session (New Session composer, no tracker issue) is stored under a
 * synthesized `SESSION-<hex>` key — a unique internal handle, not something the
 * user chose. The UI shows the session's title instead; only a real tracker
 * issue keeps its key (e.g. `PROJ-123`) on screen.
 */
export function isSynthesizedKey(issueKey: string): boolean {
  return /^SESSION-[0-9a-f]{6,}$/i.test(issueKey) || isTicketReviewKey(issueKey);
}

/**
 * A ticket review (interactive AI review) is stored under `review~<ticket key>` so
 * it never replaces the ticket's own session. That prefix mirrors core's
 * `TICKET_REVIEW_SESSION_PREFIX` — duplicated because the renderer may not import
 * values from core. The title ("Review APP-101 — …") is what belongs on screen.
 */
export function isTicketReviewKey(issueKey: string): boolean {
  return issueKey.startsWith('review~');
}

/**
 * A governed workflow stage (FX-BF-013) is stored under a synthesized
 * `WF-<run>-<node>` key too, but unlike a composer session it belongs to a run
 * the user can navigate to — so it is labelled by its stage and badged as a
 * workflow session rather than showing a key nobody chose.
 */
export function isWorkflowStageSession(session: AgentSessionRecord): boolean {
  return !!session.workflowRunId && !!session.workflowNodeId;
}

/**
 * A standalone conversation (FX-BF-045) is a free-form session that belongs to
 * no project and no ticket — plain "talk to the AI." It rides the existing
 * `AgentSessionRecord`/synthesized-key session engine rather than a new record
 * type: the identity check is what makes it a conversation, not storage. A
 * ticket always resolves to a project, so any session without one is a
 * conversation; only a governed workflow stage and a ticket review are
 * excluded, as each is reached through its run or ticket.
 */
export function isConversationSession(session: AgentSessionRecord): boolean {
  return !session.projectId
    && !session.workflowRunId
    && !isWorkflowStageSession(session)
    && !isTicketReviewKey(session.issueKey);
}

/** What to show as the session's name: the title alone for free-form sessions,
 *  `KEY — title` for tracker-issue sessions. */
export function sessionLabel(session: AgentSessionRecord): string {
  const title = sessionTitle(session);
  if (isWorkflowStageSession(session)) return title;
  return isSynthesizedKey(session.issueKey) ? title : `${session.issueKey} — ${title}`;
}

export function sessionMode(session: AgentSessionRecord): 'Chat' | 'Analysis' | 'Review' | 'Workflow' {
  if (isWorkflowStageSession(session)) return 'Workflow';
  if (session.mode === 'analysis' || session.taskDefinition.kind === 'analysis') return 'Analysis';
  if (session.mode === 'review' || session.taskDefinition.kind === 'review') return 'Review';
  return 'Chat';
}

/** Last path segment, for a compact working-directory label. */
export function basename(fsPath: string): string {
  const parts = fsPath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? fsPath;
}

export function formatStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}

export function toolModeLabel(toolMode: AgentSessionRecord['toolMode']): string {
  return toolMode === 'project-only' ? 'Project only' : toolMode === 'read-only' ? 'Read only' : 'Full tools';
}

/**
 * How long a session's work took — wall clock from start to finish, or so far
 * while it is still running.
 *
 * Always available, unlike tokens or cost, which depend on what the provider
 * chooses to report — see `formatTokens` and `formatCost`.
 */
export function formatElapsed(startedAt: string, completedAt?: string): string | undefined {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A session's cumulative token total, compactly. Returns undefined when the
 * provider reported nothing, which is every CLI-hosted session: ACP's
 * `usage_update` carries context occupancy and cost but no cumulative token
 * count, so there is genuinely nothing to total. Those sessions show duration,
 * steps, and cost instead — an invented 0 would read as "this was free".
 */
export function formatTokens(usage: AgentSessionRecord['tokenUsage']): string | undefined {
  const total = usage?.totalTokens;
  if (typeof total !== 'number' || total <= 0) {
    return undefined;
  }
  return formatTokenCount(total);
}

/** The compact k/M rendering `formatTokens` uses, for a total already summed across sessions (e.g. a spend report's grouped rows). */
export function formatTokenCount(total: number): string {
  if (total < 1000) return `${total} tokens`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tokens`;
  return `${(total / 1_000_000).toFixed(1)}M tokens`;
}

/** Compact representation of a model's context window, e.g. "128k" or "1M". */
export function formatContextLength(tokens?: number): string | undefined {
  if (typeof tokens !== 'number' || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${tokens}`;
}

/** Formatted cost rates for model menus and chips, e.g. "$1.40 / $4.40" or "Free". */
export function formatModelCost(pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number }): string | undefined {
  if (!pricing) return undefined;
  if (pricing.inputPerMillionUsd === 0 && pricing.outputPerMillionUsd === 0) {
    return 'Free';
  }
  const inStr = pricing.inputPerMillionUsd < 0.01 && pricing.inputPerMillionUsd > 0
    ? `$${pricing.inputPerMillionUsd.toFixed(3)}`
    : `$${pricing.inputPerMillionUsd.toFixed(2)}`;
  const outStr = pricing.outputPerMillionUsd < 0.01 && pricing.outputPerMillionUsd > 0
    ? `$${pricing.outputPerMillionUsd.toFixed(3)}`
    : `$${pricing.outputPerMillionUsd.toFixed(2)}`;
  if (pricing.inputPerMillionUsd === pricing.outputPerMillionUsd) {
    return `${inStr}/1M`;
  }
  return `${inStr} / ${outStr}`;
}

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

function normalizeModelName(raw: string): string {
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

/**
 * The context window for a session, in preference order:
 *
 * 1. What the provider itself reported (`contextLimit`) — fetched from the
 *    provider's own model listing for API providers, or sent by an ACP agent
 *    via `usage_update`. Authoritative: this is the number the next request
 *    will actually be rejected against.
 * 2. The selected model's known window, from `getKnownContextLength`, keyed on
 *    *this session's* model id and provider.
 * 3. `undefined` — nothing to stand on.
 *
 * The per-model step is why this exists. A single hardcoded default (this used
 * to be a flat 128k) is only ever right for one model: it shows a 200k Claude
 * as three-quarters full when it is barely used, and a 1M Gemini as nearly
 * empty when it is about to be rejected. Because the lookup is keyed on the
 * session's own model, a session that hands over to a different model measures
 * against that model's window rather than the one it started with — the
 * number follows the model for the life of the session instead of being fixed
 * once at creation.
 *
 * `undefined` rather than a fallback number: the indicator's whole value is
 * warning you before a turn is refused, so a percentage computed from a window
 * the provider never stated is worse than no percentage — it looks
 * authoritative while being wrong. Callers render nothing in that case.
 */
export function sessionContextLimit(session: AgentSessionRecord): number | undefined {
  const reported = session.contextLimit;
  if (typeof reported === 'number' && reported > 0) {
    return reported;
  }
  const known = getKnownContextLength(session.model, session.provider);
  return typeof known === 'number' && known > 0 ? known : undefined;
}

export interface ContextPressure {
  /** 0–1 share of the model's window the current prompt occupies. */
  fraction: number;
  percent: number;
  used: number;
  limit: number;
  /** `warn` past two-thirds, `critical` past 85% — where turns start failing. */
  level: 'ok' | 'warn' | 'critical';
}

/**
 * How full the model's context is for the *next* turn.
 *
 * Uses `contextTokens` (the latest turn's prompt) rather than cumulative usage:
 * a session can spend a million tokens over fifty small turns without ever
 * filling its window, so a running total would cry wolf constantly.
 *
 * Fed from two different places depending on the provider: the gateway wire
 * parser measures it for API providers, and ACP agents report it themselves
 * via `usage_update`. Returns undefined when either number is unknown — not
 * every gateway publishes a context length, and an ACP agent need not send
 * `usage_update` at all. A guessed percentage would be worse than none.
 */
export function contextPressure(session: AgentSessionRecord): ContextPressure | undefined {
  const used = session.contextTokens ?? session.tokenUsage?.inputTokens;
  const limit = sessionContextLimit(session);
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0 || used <= 0) {
    return undefined;
  }
  const fraction = Math.min(used / limit, 1);
  return {
    fraction,
    percent: Math.round(fraction * 100),
    used,
    limit,
    level: fraction >= 0.85 ? 'critical' : fraction >= 0.67 ? 'warn' : 'ok'
  };
}

/**
 * A session's cumulative cost, when the agent reports one (ACP `usage_update`).
 * Formatted through `Intl` so the agent's own currency code is respected rather
 * than assuming dollars. Sub-cent amounts round up to the smallest displayable
 * unit instead of showing "$0.00", which would read as free.
 */
export function formatCost(cost: AgentSessionRecord['cost']): string | undefined {
  if (!cost || !Number.isFinite(cost.amount) || cost.amount <= 0) {
    return undefined;
  }
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cost.currency,
      // Below a cent, two decimals renders "$0.00"; give three or four so a
      // cheap-but-not-free turn still reads as costing something.
      maximumFractionDigits: cost.amount < 0.001 ? 4 : cost.amount < 0.01 ? 3 : 2
    });
    return formatter.format(cost.amount);
  } catch {
    // An agent can send any string as a currency code; Intl throws on codes it
    // does not know. Fall back rather than lose the number entirely.
    return `${cost.amount.toFixed(2)} ${cost.currency}`;
  }
}

function truncate(text: string, max = 140): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/**
 * One line describing what the agent is doing right now — shown only while a
 * turn is in flight. Shared by the console's live-status line (which sits at
 * the bottom of a scrolling transcript, so it can scroll out of view) and the
 * inspector's copy (which must not, the same reason the task list lives
 * there rather than in the transcript).
 */
export function liveActivity(session: AgentSessionRecord): string | undefined {
  if (isTerminalAgentState(session.state) || session.state === 'awaiting_approval' || session.state === 'awaiting_input') {
    return undefined;
  }
  const events = session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'tool_complete' || event.type === 'message') break;
    if (event.type === 'tool_start') {
      const tool = event.data?.toolName ?? event.summary?.replace(/^Running tool:\s*/i, '');
      return tool ? `Running ${tool}…` : 'Running a tool…';
    }
  }
  if (session.state === 'planning') return 'Planning…';
  return session.reasoningText?.trim() ? 'Thinking…' : 'Working…';
}

/**
 * How many tool runs failed in this session.
 *
 * Drives the count on the inspector's Activity tab. It lives here rather than
 * inside the tab because the badge has to be readable *without* opening the
 * tab — that visibility is the whole point of moving the log out of a closed
 * disclosure in the transcript.
 */
export function failedToolCount(events: readonly AgentEventSummary[]): number {
  return events.filter(event =>
    event.type === 'tool_complete'
      && (event.data?.ok === false || /^tool failed/i.test(event.summary))
  ).length;
}

/**
 * The agent's reasoning stream for providers that output thinking chunks.
 * In an active turn, this reads the live stream. In a completed session,
 * it retains the latest turn's thought process for inspection.
 */
export function reasoningSnippet(session: AgentSessionRecord): string | undefined {
  const activeText = session.reasoningText?.trim();
  if (activeText) return activeText;
  if (session.events?.length) {
    for (let i = session.events.length - 1; i >= 0; i--) {
      const ev = session.events[i];
      if (ev.type === 'message' && ev.reasoning?.trim()) {
        return ev.reasoning.trim();
      }
    }
  }
  return undefined;
}

export interface SpendSummary {
  /** Totals keyed by currency, because summing across currencies is nonsense. */
  byCurrency: Array<{ currency: string; amount: number }>;
  /** Set only when every reporting session used one currency — otherwise a
   *  limit cannot be meaningfully compared and this stays undefined. */
  single?: { currency: string; amount: number };
}

/**
 * What the reporting sessions have cost, in total.
 *
 * Only sessions whose provider actually reported a cost count — today that is
 * ACP agents only. API-provider sessions contribute nothing rather than a
 * guess: turning their token counts into money would need a price table this
 * app does not have.
 *
 * Totals are grouped by currency. An agent reporting USD and another reporting
 * EUR cannot be added, so a mixed set yields no `single` total, and callers
 * must not fabricate one by picking a favourite.
 */
export function summariseSpend(sessions: readonly AgentSessionRecord[]): SpendSummary {
  const totals = new Map<string, number>();
  for (const session of sessions) {
    const cost = session.cost;
    if (!cost || !Number.isFinite(cost.amount) || cost.amount <= 0) continue;
    totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amount);
  }
  const byCurrency = [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => right.amount - left.amount);
  return { byCurrency, ...(byCurrency.length === 1 ? { single: byCurrency[0] } : {}) };
}

export interface SpendPressure {
  spent: number;
  limit: number;
  currency: string;
  percent: number;
  /** Same bands as context pressure, so the two warnings read alike. */
  level: 'ok' | 'warn' | 'critical';
}

/**
 * Spend against the user's own `ai.spendLimit`. Undefined when no limit is set
 * (`0` disables it), when nothing has reported a cost, or when sessions span
 * several currencies and the comparison would be meaningless.
 */
export function spendPressure(
  sessions: readonly AgentSessionRecord[],
  limit: number
): SpendPressure | undefined {
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const single = summariseSpend(sessions).single;
  if (!single || single.amount <= 0) return undefined;
  const fraction = single.amount / limit;
  return {
    spent: single.amount,
    limit,
    currency: single.currency,
    percent: Math.round(fraction * 100),
    level: fraction >= 0.85 ? 'critical' : fraction >= 0.67 ? 'warn' : 'ok'
  };
}

/** Sessions started within the last `days` days (by `startedAt`); every session when `days` is undefined. */
export function sessionsWithinDays(sessions: readonly AgentSessionRecord[], days?: number): AgentSessionRecord[] {
  if (!days) return sessions.slice();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter(session => {
    const started = new Date(session.startedAt).getTime();
    return Number.isFinite(started) && started >= cutoff;
  });
}

export interface SpendGroupRow {
  label: string;
  sessionCount: number;
  /** Same shape as `SpendSummary.byCurrency` — see `summariseSpend`. */
  costByCurrency: Array<{ currency: string; amount: number }>;
  /** Cumulative tokens across the group's sessions that reported any; undefined when none did. */
  totalTokens?: number;
}

function summariseGroup(sessions: readonly AgentSessionRecord[]): Omit<SpendGroupRow, 'label'> {
  const { byCurrency } = summariseSpend(sessions);
  let totalTokens: number | undefined;
  for (const session of sessions) {
    const tokens = session.tokenUsage?.totalTokens;
    if (typeof tokens === 'number' && tokens > 0) {
      totalTokens = (totalTokens ?? 0) + tokens;
    }
  }
  return { sessionCount: sessions.length, costByCurrency: byCurrency, totalTokens };
}

function groupAndSort(groups: Map<string, AgentSessionRecord[]>): SpendGroupRow[] {
  return [...groups.entries()]
    .map(([label, list]) => ({ label, ...summariseGroup(list) }))
    .sort(
      (a, b) =>
        (b.costByCurrency[0]?.amount ?? 0) - (a.costByCurrency[0]?.amount ?? 0) ||
        (b.totalTokens ?? 0) - (a.totalTokens ?? 0)
    );
}

/**
 * Spend and tokens grouped by provider + model — "which model is burning it."
 * A session with no provider recorded (older data) groups under "Unknown".
 */
export function summariseSpendByProviderModel(sessions: readonly AgentSessionRecord[]): SpendGroupRow[] {
  const groups = new Map<string, AgentSessionRecord[]>();
  for (const session of sessions) {
    const label = session.provider
      ? `${providerLabel(session.provider) ?? session.provider}${session.model ? ` · ${session.model}` : ''}`
      : 'Unknown provider';
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(session);
  }
  return groupAndSort(groups);
}

/**
 * Spend and tokens grouped by tracker connection — the closest thing to "which
 * project is this costing" the data actually supports without inventing an
 * attribution the app can't back. A session with no `connectionId` ran against
 * the built-in demo backend.
 */
export function summariseSpendByConnection(
  sessions: readonly AgentSessionRecord[],
  connections: readonly Connection[]
): SpendGroupRow[] {
  const groups = new Map<string, AgentSessionRecord[]>();
  for (const session of sessions) {
    const label = session.connectionId
      ? connections.find(connection => connection.id === session.connectionId)?.name ?? 'Removed connection'
      : 'Demo';
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(session);
  }
  return groupAndSort(groups);
}

/**
 * Whether the file change recorded on the `tool_complete` event timestamped
 * `eventTimestamp` is still the most recent edit to `path` — gates the
 * transcript's "Undo edit" button.
 *
 * Duplicated from core's `isLatestEditToPath` (same logic, kept in sync by
 * hand) rather than imported: `@praxis/core` is CommonJS with no
 * `sideEffects: false` and pulls in `chokidar`/`node-pty` transitively, so
 * Vite/Rollup cannot tree-shake a *value* import from it out of the renderer
 * bundle — it tries to inline the whole package graph, including native
 * bindings like `fsevents.node`, and the build fails. `sessionNav.ts` and
 * every other renderer module only ever `import type` from core for exactly
 * this reason; see `settingsDefaults.ts` for the same trade-off made the same
 * way. The IPC handler that actually performs the undo (`aiIpc.ts`, main
 * process) calls the real one and is the authoritative check regardless.
 */
export function isLatestEditToPath(events: readonly AgentEventSummary[], eventTimestamp: string, path: string): boolean {
  return !events.some(
    event =>
      event.type === 'tool_complete' &&
      event.timestamp > eventTimestamp &&
      event.data?.fileChanges?.some(change => change.path === path)
  );
}

/**
 * Repo-relative paths this session's tools reported writing.
 *
 * Scopes the Changes tab's Commit and Discard to the files this session
 * actually touched. `git status` reports everything dirty in the folder — the
 * agent's edits, your own work in progress, whatever another session left —
 * and acting on that whole list from a button labelled for one session sweeps
 * up unrelated work.
 *
 * Three path forms have to meet: git reports relative to the repository root,
 * ACP diff blocks are absolute, and the gateway's `write_file` is relative to
 * the session's working directory. A path that cannot be mapped into the
 * repository is dropped rather than guessed at, because the set narrows a
 * destructive action — under-matching touches less than it might, while
 * over-matching touches a file nobody attributed to this session.
 *
 * This is what the agent *said* it wrote: a shell command's writes, deletes
 * and renames are reported by no host, so treat it as a lower bound. Callers
 * must not present an empty set as "this session changed nothing".
 *
 * Duplicated from core's `reportedSessionPaths` for the same reason as
 * `isLatestEditToPath` above — a value import from `@praxis/core` breaks the
 * renderer bundle.
 */
export function reportedSessionPaths(
  events: readonly AgentEventSummary[],
  repositoryPath: string
): Set<string> {
  const toPosix = (value: string) => value.replace(/\\/g, '/');
  const isAbsolute = (value: string) => value.startsWith('/') || /^[A-Za-z]:\//.test(value);
  const root = toPosix(repositoryPath).replace(/\/+$/, '');

  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_complete') continue;
    for (const change of event.data?.fileChanges ?? []) {
      const reported = toPosix(change.path ?? '').trim();
      if (!reported) continue;
      if (root && reported.startsWith(`${root}/`)) paths.add(reported.slice(root.length + 1));
      else if (!isAbsolute(reported)) paths.add(reported.replace(/^\.\//, ''));
    }
  }
  return paths;
}

const PROVIDER_LIMIT_REGEX =
  /(?:weekly|monthly|daily|hourly|session|usage|rate|spending|billing|plan|tier|budget)[_ -]?limit|(?:hit|reached|exceeded) (?:your |its |the )?(?:\w+ )?(?:limit|budget|quota)|quota|insufficient[_ -]?(?:quota|balance|funds|credits?|budget)|out of quota|too many requests|resource[_ -]?exhausted|(?:credits?|budget)[_ -]?(?:exhausted|depleted|empty|expired|zero|insufficient|out|exceeded)|out of (?:credits?|budget)|no (?:credits?|budget) remaining|run out of (?:credits?|budget)|\bover[_ -]?budget\b|credit balance (?:is )?too low|balance (?:is )?too low|no resource package|please recharge|\b1113\b|rate[_ -]?limit|rate[_ -]?limited/i;

export function isProviderLimitMessage(text?: string): boolean {
  if (!text) return false;
  return PROVIDER_LIMIT_REGEX.test(text);
}

export function formatErrorMessage(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let status: string | undefined;
  const statusMatch = trimmed.match(/(?:Gateway returned|HTTP|status(?:\s*code)?)\s*:?\s*(\d{3})/i);
  if (statusMatch) {
    status = statusMatch[1];
  }

  let jsonCandidate = trimmed;
  const jsonBlockMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (jsonBlockMatch) {
    jsonCandidate = jsonBlockMatch[1];
  }

  let parsedMsg: string | undefined;
  let parsedCode: string | number | undefined;

  try {
    const obj = JSON.parse(jsonCandidate) as Record<string, unknown>;
    const err = (obj.error && typeof obj.error === 'object') ? (obj.error as Record<string, unknown>) : obj;
    parsedMsg = typeof err.message === 'string' ? err.message : typeof err.msg === 'string' ? err.msg : undefined;
    const rawCode = err.code ?? obj.code;
    parsedCode = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined;
  } catch {
    // not JSON
  }

  if (parsedMsg?.trim()) {
    const details: string[] = [];
    if (parsedCode !== undefined && parsedCode !== '') {
      details.push(`Code ${parsedCode}`);
    }
    if (status) {
      details.push(`HTTP ${status}`);
    }
    return details.length > 0
      ? `${parsedMsg.trim()} (${details.join(' · ')})`
      : parsedMsg.trim();
  }

  const cleaned = trimmed
    .replace(/^(?:The stage session failed:\s*)?(?:RequestError:\s*)?(?:Internal error:\s*)?(?:Provider error:\s*)?(?:Gateway returned\s*\d*:\s*)?/i, '')
    .trim();

  if (status && !cleaned.includes(status)) {
    return `${cleaned} (HTTP ${status})`;
  }

  return cleaned;
}

export function sessionLimitNotice(session?: AgentSessionRecord): string | undefined {
  if (!session) return undefined;
  // Provider responses can contain a full handover/recovery transcript. Keep
  // that operational detail out of the session error banner.
  const concise = 'This provider has reached its usage limit. Switch providers to continue, or stop this session.';
  if (session.lastError && isProviderLimitMessage(session.lastError)) return concise;
  // A reply is only read as a limit message when the session did not complete: a completed
  // session's reply is its work, and a security report recommending rate limits is not a limit.
  if (session.state !== 'completed' && session.responseText && isProviderLimitMessage(session.responseText)) return concise;
  // Only a limit the session has not moved past: a reply (or a new session start,
  // as after a handover to another AI) since the error means the limit is behind it.
  const events = session.events ?? [];
  const lastErrorIndex = events.map(e => e.type).lastIndexOf('error');
  const lastErrorEvent = lastErrorIndex >= 0 ? events[lastErrorIndex] : undefined;
  const movedOn = events.slice(lastErrorIndex + 1).some(e => e.type === 'message' || e.type === 'session_start');
  if (lastErrorEvent && !movedOn && isProviderLimitMessage(lastErrorEvent.summary || lastErrorEvent.detail)) {
    return concise;
  }
  if (session.providerLimitReached) {
    return concise;
  }
  return undefined;
}

export interface SubagentItem {
  id: string;
  title: string;
  role?: string;
  status: AgentSessionRecord['state'];
  model: string;
  tokenUsage?: AgentSessionRecord['tokenUsage'];
  cost?: AgentSessionRecord['cost'];
  sessionKey?: string;
  startedAt?: string;
  completedAt?: string;
  elapsed?: string;
  stepCount?: number;
}

export function formatSubagentTokens(tokenUsage?: AgentSessionRecord['tokenUsage'], cost?: AgentSessionRecord['cost']): string {
  if (tokenUsage) {
    if (typeof tokenUsage.totalTokens === 'number' && tokenUsage.totalTokens > 0) {
      return formatTokenCount(tokenUsage.totalTokens);
    }
    const sum = (tokenUsage.inputTokens || 0) + (tokenUsage.outputTokens || 0);
    if (sum > 0) {
      return formatTokenCount(sum);
    }
  }
  if (cost) {
    return formatCost(cost) || '0 cost';
  }
  return '0 tokens';
}

export function extractSubagents(session: AgentSessionRecord, allSessions?: AgentSessionRecord[]): SubagentItem[] {
  const items: SubagentItem[] = [];
  const seenIds = new Set<string>();

  // 1. Direct child sessions linked by parentSessionKey or controller workflow run
  const childSessions = (allSessions ?? []).filter(s => {
    if (!s || s.issueKey === session.issueKey) return false;
    if (s.parentSessionKey === session.issueKey) return true;
    if (
      session.workflowRole === 'controller' &&
      session.workflowRunId &&
      s.workflowRunId === session.workflowRunId &&
      isWorkflowStageSession(s)
    ) {
      return true;
    }
    return false;
  });

  for (const child of childSessions) {
    seenIds.add(child.issueKey);
    const role = child.workflowNodeId
      ? `Stage: ${child.workflowNodeId}`
      : child.workflowRole
        ? `Role: ${child.workflowRole}`
        : child.taskDefinition.kind && child.taskDefinition.kind !== 'general'
          ? `Kind: ${child.taskDefinition.kind}`
          : 'Subagent';

    items.push({
      id: child.issueKey,
      title: sessionTitle(child),
      role,
      status: child.state,
      model: child.model?.trim() || (child.provider ? providerLabel(child.provider) : 'Default model'),
      tokenUsage: child.tokenUsage,
      cost: child.cost,
      sessionKey: child.issueKey,
      startedAt: child.startedAt,
      completedAt: child.completedAt,
      elapsed: formatElapsed(child.startedAt, child.completedAt),
      stepCount: child.stepCount
    });
  }

  // 2. Subagent tool invocations in events (e.g. from ACP Claude Code or multi-agent tools)
  const subagentToolNames = new Set(['agent', 'task', 'invoke_subagent', 'subagent', 'delegate']);
  for (const event of session.events ?? []) {
    const rawToolName = event.data?.toolName?.toLowerCase() ?? '';
    const isSubagentTool = subagentToolNames.has(rawToolName) || rawToolName.includes('subagent');
    if (!isSubagentTool) continue;
    const callId = event.data?.callId || event.timestamp;
    if (seenIds.has(callId)) continue;
    seenIds.add(callId);

    const status: AgentSessionRecord['state'] = event.data?.ok === false
      ? 'failed'
      : event.type === 'tool_complete'
        ? 'completed'
        : 'executing';

    const eventTitle = event.data?.argsSummary
      || event.summary.replace(/^Running tool:\s*/i, '').replace(/^Tool\s*(completed|failed):\s*/i, '')
      || 'Subagent execution';

    items.push({
      id: callId,
      title: eventTitle,
      role: event.data?.toolName || 'Tool subagent',
      status,
      model: event.modelId?.trim() || session.model?.trim() || (session.provider ? providerLabel(session.provider) : 'Default model'),
      tokenUsage: event.tokenUsage,
      cost: event.cost,
      startedAt: event.timestamp,
      elapsed: event.durationMs ? `${Math.round(event.durationMs / 1000)}s` : undefined
    });
  }

  return items;
}

