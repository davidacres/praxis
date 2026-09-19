import type { AiProvider, ModelOptions } from '@praxis/core';
import type { IconName } from '../ui/Icon';

/**
 * Shared provider-category metadata for every "model picker" surface —
 * the composer's per-session picker (`NewSession.tsx`) and the Settings
 * page's model-curation panel (`ModelManagerPanel.tsx`). Kept as local
 * literals, not imported from core: core drags in Node built-ins that can't
 * bundle into the renderer (same reason `PROVIDER_LABELS` below isn't
 * derived from `PROVIDER_DESCRIPTORS`).
 */

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  'vercel-gateway': 'Vercel AI Gateway',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  'z-ai': 'Z.ai',
  'claude-code-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'GitHub Copilot',
  'antigravity-cli': 'Antigravity'
};

/**
 * `kind: 'cli-agent'` providers — hosted CLI agents (Claude Code, Codex,
 * Copilot), all driven over the Agent Client Protocol, as opposed to a plain
 * chat-completions API call. Shown with a distinct icon (terminal, vs. globe
 * for API providers).
 */
export const CLI_AGENT_PROVIDERS: ReadonlySet<AiProvider> = new Set(['claude-code-cli', 'codex-cli', 'copilot-cli', 'antigravity-cli']);

/** `hostKind: 'acp'` providers — every CLI-hosted agent, driven over the Agent Client Protocol: Claude Code, Codex, and GitHub Copilot (`copilot --acp`). */
export const ACP_PROVIDERS: ReadonlySet<AiProvider> = new Set(['claude-code-cli', 'codex-cli', 'copilot-cli', 'antigravity-cli']);

/** `kind: 'api'` providers with a real model-listing endpoint (`ai.listApiModelOptions`). */
export const API_MODEL_PROVIDERS: ReadonlySet<AiProvider> = new Set(['vercel-gateway', 'openai', 'anthropic', 'gemini', 'z-ai']);

/** Every provider `ai.listCliModelOptions` can answer for — every ACP-hosted agent, each reporting its own `model`-category `session/new` config option. */
export const CLI_MODEL_LISTING_PROVIDERS: ReadonlySet<AiProvider> = ACP_PROVIDERS;

/** Every provider with a model catalog at all. */
export const MODEL_PROVIDERS: ReadonlySet<AiProvider> = new Set([...CLI_MODEL_LISTING_PROVIDERS, ...API_MODEL_PROVIDERS]);

/**
 * The four providers with a distinct `--tone-*` identity color (see
 * `.session-chat-provider-*` in theme.css) also get their own icon shape here,
 * not just a color — 'terminal'/'globe' remain the fallback for every other
 * provider, same distinction as before.
 */
export function providerIconName(provider: AiProvider): IconName {
  switch (provider) {
    case 'openai':
      return 'provider-openai';
    case 'anthropic':
    case 'claude-code-cli':
      return 'provider-claude';
    case 'codex-cli':
      return 'provider-codex';
    case 'antigravity-cli':
      return 'provider-antigravity';
    default:
      return CLI_AGENT_PROVIDERS.has(provider) ? 'terminal' : 'globe';
  }
}

const modelOptionsCache = new Map<AiProvider, ModelOptions>();
const modelOptionsRequests = new Map<AiProvider, Promise<ModelOptions | undefined>>();

/** Fetches a provider's full model catalog (unfiltered — callers apply their own curation/selection). */
export function fetchModelOptions(provider: AiProvider, forceRefresh: boolean): Promise<ModelOptions | undefined> {
  if (!forceRefresh) {
    const cached = modelOptionsCache.get(provider);
    if (cached) return Promise.resolve(cached);
    const pending = modelOptionsRequests.get(provider);
    if (pending) return pending;
  } else {
    modelOptionsCache.delete(provider);
  }
  const request = (CLI_MODEL_LISTING_PROVIDERS.has(provider)
    ? window.praxis.ai.listCliModelOptions(provider)
    : API_MODEL_PROVIDERS.has(provider)
      ? window.praxis.ai.listApiModelOptions(provider, forceRefresh)
      : Promise.resolve(undefined)
  ).then(options => {
    if (options) modelOptionsCache.set(provider, options);
    return options;
  }).finally(() => {
    if (modelOptionsRequests.get(provider) === request) modelOptionsRequests.delete(provider);
  });
  modelOptionsRequests.set(provider, request);
  return request;
}

/** Invalidates and reloads one provider's model catalog. */
export function refreshModelOptions(provider: AiProvider): Promise<ModelOptions | undefined> {
  modelOptionsCache.delete(provider);
  return fetchModelOptions(provider, true);
}

/** Test/support hook for clearing renderer-local model catalog state. */
export function clearModelOptionsCache(): void {
  modelOptionsCache.clear();
  modelOptionsRequests.clear();
}
