import type { AiProvider } from '../types';

export type ActiveAiProvider = AiProvider | 'none';

export interface AiProviderSettings {
  provider: ActiveAiProvider;
  credential: string;
  agentName: string;
  runtimePath: string;
}

export const DEFAULT_AI_PROVIDER_SETTINGS: AiProviderSettings = {
  provider: 'none',
  credential: '',
  agentName: '',
  runtimePath: ''
};

const VALID_PROVIDERS = new Set<ActiveAiProvider>([
  'none',
  'openai',
  'claude',
  'cursor-cli',
  'copilot-cli',
  'claude-cli'
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

function readProvider(value: unknown): ActiveAiProvider {
  const provider = readString(value) as ActiveAiProvider;
  return VALID_PROVIDERS.has(provider) ? provider : 'none';
}

export function sanitizeAiProviderSettings(raw: unknown): AiProviderSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_AI_PROVIDER_SETTINGS };
  }

  return {
    provider: readProvider(raw.provider),
    credential: readString(raw.credential),
    agentName: readString(raw.agentName),
    runtimePath: readString(raw.runtimePath)
  };
}

export function isNestedAiProviderObject(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && ('credential' in raw || 'agentName' in raw || 'runtimePath' in raw);
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
    runtimePath: readString(config.get<string>('ai.runtimePath', ''))
  };
}

export interface LegacyAiSettingsSnapshot {
  defaultProvider: ActiveAiProvider;
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
  let provider = legacy.defaultProvider;
  if (provider === 'none') {
    const priority: AiProvider[] = ['copilot-cli', 'claude-cli', 'cursor-cli', 'openai', 'claude'];
    provider = priority.find(candidate => isLegacyProviderConfigured(candidate, legacy)) ?? 'none';
  }

  if (provider === 'none') {
    return undefined;
  }

  switch (provider) {
    case 'openai':
      return {
        provider,
        credential: legacy.openaiApiKey,
        agentName: legacy.openaiAgentName,
        runtimePath: ''
      };
    case 'claude':
      return {
        provider,
        credential: legacy.claudeApiKey,
        agentName: legacy.claudeAgentName,
        runtimePath: ''
      };
    case 'cursor-cli':
      return {
        provider,
        credential: legacy.cursorCliPath,
        agentName: '',
        runtimePath: ''
      };
    case 'claude-cli':
      return {
        provider,
        credential: legacy.claudeCliPath,
        agentName: '',
        runtimePath: ''
      };
    case 'copilot-cli':
      return {
        provider,
        credential: '',
        agentName: legacy.copilotAgentName,
        runtimePath: legacy.copilotCliPath
      };
    default:
      return undefined;
  }
}

export function isAiProviderConfigured(settings: AiProviderSettings): boolean {
  if (settings.provider === 'none') {
    return false;
  }
  if (settings.provider === 'copilot-cli') {
    return true;
  }
  return settings.credential.trim().length > 0;
}

function isLegacyProviderConfigured(provider: AiProvider, legacy: LegacyAiSettingsSnapshot): boolean {
  switch (provider) {
    case 'openai':
      return legacy.openaiApiKey.length > 0;
    case 'claude':
      return legacy.claudeApiKey.length > 0;
    case 'cursor-cli':
      return legacy.cursorCliPath.length > 0;
    case 'copilot-cli':
      return legacy.copilotEnabled || legacy.copilotCliPath.length > 0;
    case 'claude-cli':
      return legacy.claudeCliPath.length > 0;
    default:
      return false;
  }
}

export function legacyAiSettingsHaveValues(legacy: LegacyAiSettingsSnapshot): boolean {
  return (
    legacy.defaultProvider !== 'none' ||
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
