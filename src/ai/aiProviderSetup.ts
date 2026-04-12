import * as vscode from 'vscode';
import type { AiProvider } from '../types';

const CONFIG_ROOT = 'ticketManager';
const AI_SETTINGS_TARGET = vscode.ConfigurationTarget.Global;

export type ConfigurableAiProvider = AiProvider | 'none';

export interface AiConfigurationPromptResult {
  status: 'configured' | 'skipped' | 'cancelled';
  provider: ConfigurableAiProvider;
}

export interface AiProviderSetupOption {
  provider: ConfigurableAiProvider;
  label: string;
  description: string;
  detail?: string;
}

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  claude: 'Claude (Anthropic)',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'GitHub Copilot SDK'
};

export function buildAiProviderSetupOptions(): AiProviderSetupOption[] {
  return [
    {
      provider: 'openai',
      label: AI_PROVIDER_LABELS.openai,
      description: 'Use an OpenAI API key',
      detail: 'Good for ticket reviews and AI assignment.'
    },
    {
      provider: 'claude',
      label: AI_PROVIDER_LABELS.claude,
      description: 'Use an Anthropic API key',
      detail: 'Good for ticket reviews and AI assignment.'
    },
    {
      provider: 'cursor-cli',
      label: AI_PROVIDER_LABELS['cursor-cli'],
      description: 'Use the local Cursor CLI executable',
      detail: 'Requires the path to the Cursor CLI on this machine.'
    },
    {
      provider: 'copilot-cli',
      label: AI_PROVIDER_LABELS['copilot-cli'],
      description: 'Use the GitHub Copilot SDK',
      detail: 'Uses your existing GitHub Copilot authentication on this machine for reviews, @copilot replies, and agent tasks.'
    },
    {
      provider: 'none',
      label: 'Skip for now',
      description: 'Do not configure a default AI provider yet'
    }
  ];
}

export function sortAiOptionsByDefaultProvider<T extends { provider: AiProvider }>(
  items: T[],
  defaultProvider: ConfigurableAiProvider
): T[] {
  if (defaultProvider === 'none') {
    return [...items];
  }

  return [...items].sort((left, right) => {
    const leftRank = left.provider === defaultProvider ? 0 : 1;
    const rightRank = right.provider === defaultProvider ? 0 : 1;
    return leftRank - rightRank;
  });
}

export function describeAiConfigurationResult(result: AiConfigurationPromptResult): string {
  switch (result.status) {
    case 'configured':
      return `Default AI: ${result.provider === 'none' ? 'None' : AI_PROVIDER_LABELS[result.provider]}.`;
    case 'skipped':
      return 'No default AI selected.';
    case 'cancelled':
    default:
      return 'AI configuration cancelled.';
  }
}

function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

function getExistingSetting(key: string): string {
  return getConfiguration().get<string>(key, '').trim();
}

async function promptForSecretValue(
  settingKey: string,
  title: string,
  prompt: string
): Promise<string | undefined> {
  const existing = getExistingSetting(settingKey);
  const value = await vscode.window.showInputBox({
    title,
    prompt: existing ? `${prompt} Leave blank to keep the current value.` : prompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: input =>
      existing.length > 0 || input.trim().length > 0 ? undefined : 'This value is required.'
  });

  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || existing;
}

async function promptForPathValue(
  settingKey: string,
  title: string,
  prompt: string
): Promise<string | undefined> {
  const existing = getExistingSetting(settingKey);
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    value: existing,
    ignoreFocusOut: true,
    validateInput: input => (input.trim().length > 0 ? undefined : 'This value is required.')
  });

  if (value === undefined) {
    return undefined;
  }

  return value.trim();
}

export async function promptToConfigureDefaultAiProvider(): Promise<AiConfigurationPromptResult> {
  const configuration = getConfiguration();
  const defaultProvider = configuration.get<ConfigurableAiProvider>('ai.defaultProvider', 'none');
  const options = buildAiProviderSetupOptions();
  const prioritizedOptions =
    defaultProvider === 'none'
      ? options
      : [
          ...options.filter(option => option.provider === defaultProvider),
          ...options.filter(option => option.provider !== defaultProvider)
        ];

  const picked = await vscode.window.showQuickPick(
    prioritizedOptions.map(option => ({
      label: option.label,
      description: option.description,
      detail: option.detail,
      option
    })),
    {
      title: 'Ticket Manager: Default AI Provider',
      placeHolder: 'Choose which AI should be configured for reviews and agent actions.'
    }
  );

  if (!picked) {
    return { status: 'cancelled', provider: defaultProvider };
  }

  const provider = picked.option.provider;
  if (provider === 'none') {
    await configuration.update('ai.defaultProvider', 'none', AI_SETTINGS_TARGET);
    return { status: 'skipped', provider };
  }

  if (provider === 'openai') {
    const apiKey = await promptForSecretValue(
      'ai.openaiApiKey',
      'Ticket Manager: OpenAI API Key',
      'Enter the OpenAI API key to use for ticket reviews and AI assignment.'
    );
    if (apiKey === undefined) {
      return { status: 'cancelled', provider };
    }

    const currentAgentName = getExistingSetting('ai.openaiAgentName');
    await Promise.all([
      configuration.update('ai.openaiApiKey', apiKey, AI_SETTINGS_TARGET),
      configuration.update(
        'ai.openaiAgentName',
        currentAgentName || AI_PROVIDER_LABELS.openai,
        AI_SETTINGS_TARGET
      ),
      configuration.update('ai.defaultProvider', provider, AI_SETTINGS_TARGET)
    ]);
    return { status: 'configured', provider };
  }

  if (provider === 'claude') {
    const apiKey = await promptForSecretValue(
      'ai.claudeApiKey',
      'Ticket Manager: Claude API Key',
      'Enter the Anthropic API key to use for ticket reviews and AI assignment.'
    );
    if (apiKey === undefined) {
      return { status: 'cancelled', provider };
    }

    const currentAgentName = getExistingSetting('ai.claudeAgentName');
    await Promise.all([
      configuration.update('ai.claudeApiKey', apiKey, AI_SETTINGS_TARGET),
      configuration.update(
        'ai.claudeAgentName',
        currentAgentName || AI_PROVIDER_LABELS.claude,
        AI_SETTINGS_TARGET
      ),
      configuration.update('ai.defaultProvider', provider, AI_SETTINGS_TARGET)
    ]);
    return { status: 'configured', provider };
  }

  if (provider === 'cursor-cli') {
    const cliPath = await promptForPathValue(
      'ai.cursorCliPath',
      'Ticket Manager: Cursor CLI Path',
      'Enter the path to the Cursor CLI executable to use for AI tasks.'
    );
    if (cliPath === undefined) {
      return { status: 'cancelled', provider };
    }

    await Promise.all([
      configuration.update('ai.cursorCliPath', cliPath, AI_SETTINGS_TARGET),
      configuration.update('ai.defaultProvider', provider, AI_SETTINGS_TARGET)
    ]);
    return { status: 'configured', provider };
  }

  await Promise.all([
    configuration.update('ai.copilotEnabled', true, AI_SETTINGS_TARGET),
    configuration.update('ai.copilotCliPath', '', AI_SETTINGS_TARGET),
    configuration.update('ai.defaultProvider', provider, AI_SETTINGS_TARGET)
  ]);
  return { status: 'configured', provider };
}
