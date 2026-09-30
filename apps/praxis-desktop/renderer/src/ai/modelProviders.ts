import type { AiProvider, CustomProviderConfig, ModelOptions, ProviderCapabilities, ReasoningEffort } from '@praxis/core';
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

/**
 * User-added OpenAI-compatible endpoints (`custom:<slug>`), mirrored from
 * settings by `main.tsx` so every label/capability lookup below knows them.
 * Built-ins keep their literals above; a custom endpoint is known only here.
 */
const customProviders = new Map<string, { label: string; capabilities?: ProviderCapabilities }>();
let customProvidersKey = '';

/** Local copy of core's `isCustomProviderId` — the renderer imports only types from core. */
export function isCustomProvider(provider: string | undefined): boolean {
  return typeof provider === 'string' && provider.startsWith('custom:');
}

export function setCustomProviderCatalog(configs: readonly CustomProviderConfig[] | undefined): void {
  const key = JSON.stringify(configs ?? []);
  if (key === customProvidersKey) return;
  customProvidersKey = key;
  customProviders.clear();
  for (const config of configs ?? []) customProviders.set(config.id, { label: config.label, capabilities: config.capabilities });
  // A changed URL or auth makes a cached catalog stale.
  for (const provider of [...modelOptionsCache.keys()]) if (isCustomProvider(provider)) modelOptionsCache.delete(provider);
}

/** The ids of the user-added endpoints, in settings order. */
export function customProviderIds(): AiProvider[] {
  return [...customProviders.keys()] as AiProvider[];
}

/** Every provider with a model catalog: the built-ins, then the user-added endpoints. */
export function allModelProviderIds(): AiProvider[] {
  return [...MODEL_PROVIDERS, ...customProviderIds()];
}

/** Display name for any provider id — a custom endpoint's own name, a built-in's label, else the id. */
export function providerLabel(provider: AiProvider | string): string {
  return customProviders.get(provider)?.label ?? PROVIDER_LABELS[provider as AiProvider] ?? provider;
}

/** A `kind: 'api'` provider with a model-listing endpoint — every built-in API provider and every custom endpoint. */
export function isApiModelProvider(provider: AiProvider | string): boolean {
  return API_MODEL_PROVIDERS.has(provider as AiProvider) || isCustomProvider(provider);
}

/** Any provider with a model catalog at all. */
export function hasModelCatalog(provider: AiProvider | string): boolean {
  return MODEL_PROVIDERS.has(provider as AiProvider) || isCustomProvider(provider);
}

/**
 * Whether the provider can run agent sessions and workflows (which call tools).
 * False only for a custom endpoint whose last connection test showed no tool
 * calling — an untested endpoint and every built-in are assumed able.
 */
export function providerSupportsTools(provider: AiProvider | string): boolean {
  const capabilities = customProviders.get(provider)?.capabilities;
  return !capabilities || capabilities.tools;
}

export const NO_TOOLS_REASON = "Didn't pass tool calling, which agent sessions need — run its connection test in Settings → AI Provider.";

/** Every reasoning/thinking effort level, in menu order. */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

/**
 * Browser-safe mirror of core's `supportsReasoningEffort`. Every selectable
 * model gets the composer control and a per-model default; transport adapters
 * decide how to apply the normalized value. Keep in sync with core's version.
 */
export function supportsReasoningEffort(provider: AiProvider | string | undefined, _model: string | undefined): boolean {
  return Boolean(provider);
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
    : isApiModelProvider(provider)
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
