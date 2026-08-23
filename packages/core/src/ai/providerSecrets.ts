import type { SecretsStore } from '../host/secrets';
import type { AiProvider } from '../types';
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
  return provider === 'vercel-gateway' ? SECRET_VERCEL_API_KEY : `ticketManager.${provider}ApiKey`;
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
