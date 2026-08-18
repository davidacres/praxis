import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';
import { DEFAULT_AI_PROVIDER_SETTINGS } from '../config/aiProviderConfig';
import type { AiProvider } from '../types';

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

export const AI_PROVIDER_LABELS: Record<Exclude<ConfigurableAiProvider, 'none'>, string> = {
  'vercel-gateway': 'Vercel AI Gateway'
};

export function buildAiProviderSetupOptions(): AiProviderSetupOption[] {
  return [
    {
      provider: 'vercel-gateway',
      label: AI_PROVIDER_LABELS['vercel-gateway'],
      description: 'Configure the Vercel AI Gateway',
      detail: 'Opens the AI Gateway settings page for URL and API key.'
    },
    {
      provider: 'none',
      label: 'Disable AI',
      description: 'Clear the active AI provider'
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

/**
 * Configure AI: open the Vercel Gateway settings page, or disable AI.
 */
export async function promptToConfigureDefaultAiProvider(options?: {
  openVercelGatewaySettings?: () => void | Promise<void>;
  configStore?: AppConfigStore;
}): Promise<AiConfigurationPromptResult> {
  const configStore = options?.configStore ?? new AppConfigStore();
  const activeProvider = configStore.getAiProviderSettings().provider;
  const setupOptions = buildAiProviderSetupOptions();
  const prioritizedOptions =
    activeProvider === 'none'
      ? setupOptions
      : [
          ...setupOptions.filter(option => option.provider === activeProvider),
          ...setupOptions.filter(option => option.provider !== activeProvider)
        ];

  const picked = await vscode.window.showQuickPick(
    prioritizedOptions.map(option => ({
      label: option.label,
      description: option.description,
      detail: option.detail,
      option
    })),
    {
      title: 'Ticket Manager: AI',
      placeHolder: 'Configure Vercel AI Gateway or disable AI.'
    }
  );

  if (!picked) {
    return { status: 'cancelled', provider: activeProvider };
  }

  const provider = picked.option.provider;
  if (provider === 'none') {
    await configStore.setAiProviderSettings({ ...DEFAULT_AI_PROVIDER_SETTINGS });
    try {
      await configStore.clearVercelGatewayApiKey();
    } catch {
      // SecretStorage may be unbound in unit-test contexts.
    }
    return { status: 'skipped', provider };
  }

  if (options?.openVercelGatewaySettings) {
    await options.openVercelGatewaySettings();
  } else {
    await vscode.commands.executeCommand('ticketManager.openAiGatewaySettings');
  }
  return { status: 'configured', provider: 'vercel-gateway' };
}
