import type { AiSettings } from '../config/appSettings';
import type { SecretsStore } from '../host/secrets';
import type { AiProvider } from '../types';
import { getProviderDescriptor, listCustomProviderIds } from './providers/registry';
import { isCustomProviderId } from './providers/customProviders';
import { isExecutableAvailable } from './cliProbe';
import {
  clearVercelApiKey,
  getStoredVercelApiKey,
  resolveVercelApiKey,
  storeVercelApiKey,
  SECRET_VERCEL_API_KEY
} from './gatewaySecrets';

/**
 * Per-provider API key storage, generalizing `gatewaySecrets.ts`'s
 * Vercel-only functions. `'vercel-gateway'` delegates to the existing
 * functions unchanged (same secret key, same env-fallback chain) so
 * previously-stored keys keep resolving without a migration step.
 */
export function secretKeyForProvider(provider: AiProvider): string {
  if (provider === 'vercel-gateway') return SECRET_VERCEL_API_KEY;
  // One keychain entry per endpoint, never shared between two endpoints of the same preset.
  if (isCustomProviderId(provider)) return `praxis.customProvider.${provider.slice('custom:'.length)}.apiKey`;
  return `praxis.${provider}ApiKey`;
}

/**
 * Whether an API provider needs a key before it can be called. Only a custom
 * endpoint set to "No key" (a local runtime) does not; CLI providers never do.
 */
export function providerNeedsApiKey(provider: AiProvider): boolean {
  const descriptor = getProviderDescriptor(provider);
  return descriptor.kind === 'api' && descriptor.custom?.auth.kind !== 'none';
}

/** Providers whose credentials are stored in the AI provider secrets namespace. */
const API_KEY_PROVIDERS: AiProvider[] = ['vercel-gateway', 'openai', 'anthropic', 'gemini', 'z-ai'];

/** Clears all AI provider keys without touching connection or OAuth secrets. */
export async function resetProviderApiKeys(secrets: SecretsStore): Promise<void> {
  await Promise.all([...API_KEY_PROVIDERS, ...listCustomProviderIds()].map(provider => clearProviderApiKey(secrets, provider)));
}

export async function getStoredProviderApiKey(
  secrets: SecretsStore,
  provider: AiProvider
): Promise<string | undefined> {
  if (provider === 'vercel-gateway') {
    return getStoredVercelApiKey(secrets);
  }
  const stored = await secrets.get(secretKeyForProvider(provider));
  const trimmed = stored?.trim();
  return trimmed || undefined;
}

export async function storeProviderApiKey(
  secrets: SecretsStore,
  provider: AiProvider,
  value: string
): Promise<void> {
  if (provider === 'vercel-gateway') {
    return storeVercelApiKey(secrets, value);
  }
  const trimmed = value.trim();
  const key = secretKeyForProvider(provider);
  if (!trimmed) {
    await secrets.delete(key);
    return;
  }
  await secrets.store(key, trimmed);
}

export async function clearProviderApiKey(secrets: SecretsStore, provider: AiProvider): Promise<void> {
  if (provider === 'vercel-gateway') {
    return clearVercelApiKey(secrets);
  }
  await secrets.delete(secretKeyForProvider(provider));
}

/** Resolve the effective API key: SecretStorage → env fallback (`vercel-gateway` only). */
export async function resolveProviderApiKey(
  secrets: SecretsStore,
  provider: AiProvider
): Promise<string | undefined> {
  if (provider === 'vercel-gateway') {
    return resolveVercelApiKey(secrets);
  }
  return getStoredProviderApiKey(secrets, provider);
}

/** Providers that can run the constrained recommendation prompt, either through
 * a direct API completion or through an ACP-hosted CLI subprocess. */
const RECOMMENDATION_CANDIDATE_PROVIDERS: readonly AiProvider[] = [
  'vercel-gateway',
  'openai',
  'anthropic',
  'gemini',
  'z-ai',
  'claude-code-cli',
  'codex-cli',
  'copilot-cli',
  'antigravity-cli'
];

export interface RecommendationProviderChoice {
  provider: AiProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function recommendationProviderConfig(provider: AiProvider, ai: AiSettings): { baseUrl?: string; model?: string } {
  if (provider === 'vercel-gateway') {
    return { baseUrl: ai.gatewayUrl.trim() || undefined, model: ai.defaultModel.trim() || undefined };
  }
  const config = ai.providers[provider];
  return { baseUrl: config?.baseUrl?.trim() || undefined, model: config?.defaultModel?.trim() || undefined };
}

/** The key to call `provider` with: `{ ready: false }` when one is needed and missing. */
async function apiCredentials(secrets: SecretsStore, provider: AiProvider): Promise<{ ready: boolean; apiKey?: string }> {
  const apiKey = await resolveProviderApiKey(secrets, provider);
  return { ready: Boolean(apiKey) || !providerNeedsApiKey(provider), apiKey };
}

/**
 * Picks which provider a one-shot AI "recommendation" completion
 * (workflow template pick, workflow agent-for-stage pick) should use, and
 * resolves its credentials/config in one step. API providers use their direct
 * completion endpoint; ACP providers are launched by the desktop host.
 *
 * `ai.recommendationProvider` wins outright when set — if it isn't actually
 * configured, this throws rather than silently substituting a provider the
 * user didn't choose. Left unset ("Auto"), it prefers `activeProvider` when
 * that happens to be an api-kind, configured provider, then falls back to the
 * first configured api-kind provider. CLI-hosted providers (Claude Code,
 * Codex, Copilot) never qualify — they have no direct completion endpoint,
 * only a subprocess/ACP handshake.
 */
export async function resolveRecommendationProvider(
  secrets: SecretsStore,
  ai: AiSettings
): Promise<RecommendationProviderChoice> {
  const explicit = ai.recommendationProvider;
  if (explicit) {
    const descriptor = getProviderDescriptor(explicit);
    if (ai.providers[explicit]?.enabled === false) {
      throw new Error(
        `${descriptor.label} is turned off — enable it in Settings → AI Provider, or change the Recommendations provider setting.`
      );
    }
    if (descriptor.kind === 'cli-agent') {
      const command = ai.providers[explicit]?.cliPath?.trim() || descriptor.defaultCommand;
      if (!command || !(await isExecutableAvailable(command))) {
        throw new Error(
          `${descriptor.label} is not available — install or configure its ACP command in Settings → AI, or change the Recommendations provider setting.`
        );
      }
      return { provider: explicit, ...recommendationProviderConfig(explicit, ai) };
    }
    const { ready, apiKey } = await apiCredentials(secrets, explicit);
    if (!ready) {
      throw new Error(
        `${descriptor.label} is not configured — add an API key in Settings → AI, or change the Recommendations provider setting.`
      );
    }
    return { provider: explicit, ...(apiKey ? { apiKey } : {}), ...recommendationProviderConfig(explicit, ai) };
  }

  const tried = new Set<AiProvider>();
  const candidates = [...RECOMMENDATION_CANDIDATE_PROVIDERS, ...listCustomProviderIds()];
  const ordered = [ai.activeProvider, ...candidates].filter(provider => {
    if (ai.providers[provider]?.enabled === false) {
      return false;
    }
    if (!candidates.includes(provider) || tried.has(provider)) {
      return false;
    }
    tried.add(provider);
    return true;
  });
  for (const provider of ordered) {
    const descriptor = getProviderDescriptor(provider);
    if (descriptor.kind === 'cli-agent') {
      const command = ai.providers[provider]?.cliPath?.trim() || descriptor.defaultCommand;
      if (command && (await isExecutableAvailable(command))) {
        return { provider, ...recommendationProviderConfig(provider, ai) };
      }
      continue;
    }
    const { ready, apiKey } = await apiCredentials(secrets, provider);
    if (ready) {
      return { provider, ...(apiKey ? { apiKey } : {}), ...recommendationProviderConfig(provider, ai) };
    }
  }
  throw new Error('No AI provider is configured — add an API key or an available ACP host in Settings → AI to use recommendations.');
}
