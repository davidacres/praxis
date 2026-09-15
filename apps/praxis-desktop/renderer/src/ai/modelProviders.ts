import type { AiProvider, ModelOptions } from '@praxis/core';

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
export const API_MODEL_PROVIDERS: ReadonlySet<AiProvider> = new Set(['vercel-gateway', 'openai', 'anthropic']);

/** Every provider `ai.listCliModelOptions` can answer for — every ACP-hosted agent, each reporting its own `model`-category `session/new` config option. */
export const CLI_MODEL_LISTING_PROVIDERS: ReadonlySet<AiProvider> = ACP_PROVIDERS;

/** Every provider with a model catalog at all. */
export const MODEL_PROVIDERS: ReadonlySet<AiProvider> = new Set([...CLI_MODEL_LISTING_PROVIDERS, ...API_MODEL_PROVIDERS]);

/** 'terminal' for a hosted CLI agent, 'globe' for a plain chat-completions API provider. */
export function providerIconName(provider: AiProvider): 'terminal' | 'globe' {
  return CLI_AGENT_PROVIDERS.has(provider) ? 'terminal' : 'globe';
}

/** Fetches a provider's full model catalog (unfiltered — callers apply their own curation/selection). */
export function fetchModelOptions(provider: AiProvider, forceRefresh: boolean): Promise<ModelOptions | undefined> {
  if (CLI_MODEL_LISTING_PROVIDERS.has(provider)) {
    return window.praxis.ai.listCliModelOptions(provider);
  }
  if (API_MODEL_PROVIDERS.has(provider)) {
    return window.praxis.ai.listApiModelOptions(provider, forceRefresh);
  }
  return Promise.resolve(undefined);
}
