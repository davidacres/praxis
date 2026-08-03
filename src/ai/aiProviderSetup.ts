import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';
import { DEFAULT_AI_PROVIDER_SETTINGS } from '../config/aiProviderConfig';
import type { AiProvider } from '../types';

const AI_SETTINGS_TARGET = vscode.ConfigurationTarget.Global;

export type ConfigurableAiProvider = AiProvider | 'claude-cli' | 'none';

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

export const AI_PROVIDER_LABELS: Record<Exclude<ConfigurableAiProvider, 'none'>, string> = {
  openai: 'OpenAI',
  claude: 'Claude (Anthropic)',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'GitHub Copilot SDK',
  'claude-cli': 'Claude Code CLI'
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
      detail: 'Uses Cursor editor language models for analysis. The CLI path is reserved for future agent tasks.'
    },
    {
      provider: 'copilot-cli',
      label: AI_PROVIDER_LABELS['copilot-cli'],
      description: 'Use the GitHub Copilot SDK',
      detail: 'Uses GitHub Copilot SDK for analysis, @copilot replies, and agent tasks.'
    },
    {
      provider: 'claude-cli',
      label: AI_PROVIDER_LABELS['claude-cli'],
      description: 'Use the Claude Code CLI for agent tasks',
      detail: 'Uses Claude Code CLI on this machine for analysis and agent tasks.'
    },
    {
      provider: 'none',
      label: 'Disable AI',
      description: 'Clear the active AI provider and credentials'
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
      return `Active AI: ${result.provider === 'none' ? 'None' : AI_PROVIDER_LABELS[result.provider]}.`;
    case 'skipped':
      return 'AI provider disabled.';
    case 'cancelled':
    default:
      return 'AI configuration cancelled.';
  }
}

async function promptForSecretValue(
  title: string,
  prompt: string,
  existing: string
): Promise<string | undefined> {
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
  title: string,
  prompt: string,
  existing: string
): Promise<string | undefined> {
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
  const configStore = new AppConfigStore();
  const currentSettings = configStore.getAiProviderSettings();
  const activeProvider = currentSettings.provider;
  const options = buildAiProviderSetupOptions();
  const prioritizedOptions =
    activeProvider === 'none'
      ? options
      : [
          ...options.filter(option => option.provider === activeProvider),
          ...options.filter(option => option.provider !== activeProvider)
        ];

  const picked = await vscode.window.showQuickPick(
    prioritizedOptions.map(option => ({
      label: option.label,
      description: option.description,
      detail: option.detail,
      option
    })),
    {
      title: 'Ticket Manager: Active AI Provider',
      placeHolder: 'Choose the single AI provider Ticket Manager should use.'
    }
  );

  if (!picked) {
    return { status: 'cancelled', provider: activeProvider };
  }

  const provider = picked.option.provider;
  if (provider === 'none') {
    await configStore.setAiProviderSettings({ ...DEFAULT_AI_PROVIDER_SETTINGS });
    return { status: 'skipped', provider };
  }

  if (provider === 'openai') {
    const apiKey = await promptForSecretValue(
      'Ticket Manager: OpenAI API Key',
      'Enter the OpenAI API key to use for ticket reviews and AI assignment.',
      currentSettings.provider === 'openai' ? currentSettings.credential : ''
    );
    if (apiKey === undefined) {
      return { status: 'cancelled', provider: activeProvider };
    }

    await configStore.setAiProviderSettings({
      provider,
      credential: apiKey,
      agentName: currentSettings.provider === 'openai' && currentSettings.agentName
        ? currentSettings.agentName
        : AI_PROVIDER_LABELS.openai,
      runtimePath: ''
    });
    return { status: 'configured', provider };
  }

  if (provider === 'claude') {
    const apiKey = await promptForSecretValue(
      'Ticket Manager: Claude API Key',
      'Enter the Anthropic API key to use for ticket reviews and AI assignment.',
      currentSettings.provider === 'claude' ? currentSettings.credential : ''
    );
    if (apiKey === undefined) {
      return { status: 'cancelled', provider: activeProvider };
    }

    await configStore.setAiProviderSettings({
      provider,
      credential: apiKey,
      agentName: currentSettings.provider === 'claude' && currentSettings.agentName
        ? currentSettings.agentName
        : AI_PROVIDER_LABELS.claude,
      runtimePath: ''
    });
    return { status: 'configured', provider };
  }

  if (provider === 'claude-cli') {
    const cliPath = await promptForPathValue(
      'Ticket Manager: Claude Code CLI Path',
      'Enter the path to the Claude Code CLI executable to use for AI tasks.',
      currentSettings.provider === 'claude-cli' ? currentSettings.credential : ''
    );
    if (cliPath === undefined) {
      return { status: 'cancelled', provider: activeProvider };
    }

    await configStore.setAiProviderSettings({
      provider,
      credential: cliPath,
      agentName: '',
      runtimePath: ''
    });
    return { status: 'configured', provider };
  }

  if (provider === 'cursor-cli') {
    const cliPath = await promptForPathValue(
      'Ticket Manager: Cursor CLI Path',
      'Enter the path to the Cursor CLI executable to use for AI tasks.',
      currentSettings.provider === 'cursor-cli' ? currentSettings.credential : ''
    );
    if (cliPath === undefined) {
      return { status: 'cancelled', provider: activeProvider };
    }

    await configStore.setAiProviderSettings({
      provider,
      credential: cliPath,
      agentName: '',
      runtimePath: ''
    });
    return { status: 'configured', provider };
  }

  await configStore.setAiProviderSettings({
    provider: 'copilot-cli',
    credential: '',
    agentName: currentSettings.provider === 'copilot-cli' ? currentSettings.agentName : '',
    runtimePath: ''
  });
  return { status: 'configured', provider };
}
