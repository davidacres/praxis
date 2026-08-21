import type { SecretsStore } from '../host/secrets';
import { resolveGatewayApiKeyFromEnv } from './gateway';

/** Secret key for the Vercel AI Gateway API key (Frosty-style). */
export const SECRET_VERCEL_API_KEY = 'ticketManager.vercelApiKey';

export async function getStoredVercelApiKey(
  secrets: SecretsStore
): Promise<string | undefined> {
  const stored = await secrets.get(SECRET_VERCEL_API_KEY);
  const trimmed = stored?.trim();
  return trimmed || undefined;
}

export async function hasStoredVercelApiKey(secrets: SecretsStore): Promise<boolean> {
  return (await getStoredVercelApiKey(secrets)) !== undefined;
}

export async function storeVercelApiKey(
  secrets: SecretsStore,
  value: string
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await secrets.delete(SECRET_VERCEL_API_KEY);
    return;
  }
  await secrets.store(SECRET_VERCEL_API_KEY, trimmed);
}

export async function clearVercelApiKey(secrets: SecretsStore): Promise<void> {
  await secrets.delete(SECRET_VERCEL_API_KEY);
}

/**
 * Resolve the effective gateway API key:
 * SecretStorage → legacy settings credential → env fallbacks.
 */
export async function resolveVercelApiKey(
  secrets: SecretsStore,
  legacyCredential?: string
): Promise<string | undefined> {
  const fromSecret = await getStoredVercelApiKey(secrets);
  if (fromSecret) {
    return fromSecret;
  }
  const fromLegacy = legacyCredential?.trim();
  if (fromLegacy) {
    return fromLegacy;
  }
  const fromEnv = resolveGatewayApiKeyFromEnv();
  return fromEnv || undefined;
}

/**
 * One-time migrate: if settings still hold a vercel credential, move it into
 * SecretStorage and return the cleared credential value for the caller to persist.
 */
export async function migrateVercelCredentialToSecretStorage(
  secrets: SecretsStore,
  legacyCredential: string | undefined
): Promise<{ migrated: boolean; apiKey?: string }> {
  const existing = await getStoredVercelApiKey(secrets);
  if (existing) {
    return { migrated: false, apiKey: existing };
  }
  const legacy = legacyCredential?.trim();
  if (!legacy) {
    return { migrated: false };
  }
  await storeVercelApiKey(secrets, legacy);
  return { migrated: true, apiKey: legacy };
}
