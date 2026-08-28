import type { AiProvider } from '@ticket-manager/core';

export type ActiveAiProvider = AiProvider | 'none';

export interface AiProviderSettings {
  provider: ActiveAiProvider;
  credential: string;
  agentName: string;
  runtimePath: string;
  /** Vercel AI Gateway base URL. Empty means default / env fallback. */
  vercelUrl: string;
}

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  provider: 'none',
  credential: '',
  agentName: '',
  runtimePath: '',
  vercelUrl: ''
};

const VALID_PROVIDERS = new Set<ActiveAiProvider>(['none', 'vercel-gateway']);

/** Former multi-provider values silently coerce to vercel-gateway. */
const LEGACY_TO_VERCEL = new Set([
  'copilot-cli',
  'openai',
  'claude',
  'cursor-cli',
  'claude-cli',
  'vercel-gateway'
]);

export const LEGACY_AI_SETTING_KEYS = [
  'ai.defaultProvider',
  'ai.openaiApiKey',
  'ai.claudeApiKey',
  'ai.cursorCliPath',
  'ai.copilotEnabled',
  'ai.copilotCliPath',
  'ai.copilotAgentName',
  'ai.claudeCliPath',
  'ai.openaiAgentName',
  'ai.claudeAgentName'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceProvider(value: string): ActiveAiProvider {
  if (!value || value === 'none') {
    return 'none';
  }
  if (LEGACY_TO_VERCEL.has(value) || VALID_PROVIDERS.has(value as ActiveAiProvider)) {
    return value === 'none' ? 'none' : 'vercel-gateway';
  }
  return 'none';
}

function readProvider(value: unknown): ActiveAiProvider {
  return coerceProvider(readString(value));
}

export function sanitizeAiProviderSettings(raw: unknown): AiProviderSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_AI_PROVIDER_SETTINGS };
  }

  return {
    provider: readProvider(raw.provider),
    credential: readString(raw.credential),
    agentName: readString(raw.agentName),
    runtimePath: readString(raw.runtimePath),
    vercelUrl: readString(raw.vercelUrl)
  };
}

export function isNestedAiProviderObject(raw: unknown): raw is Record<string, unknown> {
  return (
    isRecord(raw) &&
    ('credential' in raw || 'agentName' in raw || 'runtimePath' in raw || 'vercelUrl' in raw)
  );
}

export function readFlatAiProviderSettings(config: {
  get<T>(key: string, defaultValue?: T): T;
}): AiProviderSettings {
  const rawProvider = config.get<unknown>('ai.provider');
  if (isNestedAiProviderObject(rawProvider)) {
    return sanitizeAiProviderSettings(rawProvider);
  }

  return {
    provider: readProvider(rawProvider),
    credential: readString(config.get<string>('ai.credential', '')),
    agentName: readString(config.get<string>('ai.agentName', '')),
    runtimePath: readString(config.get<string>('ai.runtimePath', '')),
    vercelUrl: readString(config.get<string>('ai.vercelUrl', ''))
  };
}

export interface LegacyAiSettingsSnapshot {
  defaultProvider: ActiveAiProvider | string;
  openaiApiKey: string;
  claudeApiKey: string;
  cursorCliPath: string;
  copilotEnabled: boolean;
  copilotCliPath: string;
  copilotAgentName: string;
  claudeCliPath: string;
  openaiAgentName: string;
  claudeAgentName: string;
}

export function buildAiProviderSettingsFromLegacy(
  legacy: LegacyAiSettingsSnapshot
): AiProviderSettings | undefined {
  const hadAnyAi =
    legacyAiSettingsHaveValues(legacy) ||
    coerceProvider(String(legacy.defaultProvider)) === 'vercel-gateway';

  if (!hadAnyAi && coerceProvider(String(legacy.defaultProvider)) === 'none') {
    return undefined;
  }

  // Multi-provider legacy installs become Vercel Gateway; credentials must be
  // entered again in AI Gateway Settings (except env fallbacks).
  if (
    legacy.copilotEnabled ||
    legacy.copilotCliPath ||
    legacy.openaiApiKey ||
    legacy.claudeApiKey ||
    legacy.cursorCliPath ||
    legacy.claudeCliPath ||
    coerceProvider(String(legacy.defaultProvider)) === 'vercel-gateway'
  ) {
    return {
      provider: 'vercel-gateway',
      credential: '',
      agentName: legacy.copilotAgentName || legacy.openaiAgentName || legacy.claudeAgentName || '',
      runtimePath: '',
      vercelUrl: ''
    };
  }

  return undefined;
}

export function isAiProviderConfigured(
  settings: AiProviderSettings,
  options?: { secretCredentialPresent?: boolean }
): boolean {
  if (settings.provider === 'none') {
    return false;
  }
  return settings.credential.trim().length > 0 || Boolean(options?.secretCredentialPresent);
}

export function legacyAiSettingsHaveValues(legacy: LegacyAiSettingsSnapshot): boolean {
  return (
    String(legacy.defaultProvider) !== 'none' ||
    legacy.openaiApiKey.length > 0 ||
    legacy.claudeApiKey.length > 0 ||
    legacy.cursorCliPath.length > 0 ||
    legacy.copilotEnabled ||
    legacy.copilotCliPath.length > 0 ||
    legacy.copilotAgentName.length > 0 ||
    legacy.claudeCliPath.length > 0 ||
    legacy.openaiAgentName.length > 0 ||
    legacy.claudeAgentName.length > 0
  );
}
