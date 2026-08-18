export const DEFAULT_VERCEL_URL = 'https://ai-gateway.vercel.sh';
export const VERCEL_GATEWAY_PREFIX = 'Vercel/';

export function defaultGatewayUrl(): string {
  return DEFAULT_VERCEL_URL;
}

export function normalizeInboundModelId(wireId: string): string {
  const trimmed = wireId.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith(VERCEL_GATEWAY_PREFIX)) {
    return trimmed;
  }
  return `${VERCEL_GATEWAY_PREFIX}${trimmed}`;
}

export function toWireModelId(internalId: string): string {
  if (internalId.startsWith(VERCEL_GATEWAY_PREFIX)) {
    return internalId.slice(VERCEL_GATEWAY_PREFIX.length);
  }
  return internalId;
}

export function resolveGatewayUrlFromEnv(configuredUrl?: string): string {
  const fromConfig = configuredUrl?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv =
    process.env.AI_GATEWAY_URL?.trim() ||
    process.env.VERCEL_AI_GATEWAY_URL?.trim() ||
    process.env.FROSTY_VERCEL_URL?.trim();
  return fromEnv || DEFAULT_VERCEL_URL;
}

export function resolveGatewayApiKeyFromEnv(configuredKey?: string): string {
  const fromConfig = configuredKey?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  return (
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_OIDC_TOKEN?.trim() ||
    process.env.FROSTY_VERCEL_API_KEY?.trim() ||
    ''
  );
}
