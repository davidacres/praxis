import * as vscode from 'vscode';
import { AI_PROVIDER_LABELS } from '../ai/aiProviderSetup';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import type { AiProvider, BackendMode, ConnectionCheck } from '../types';

type StatusTone = 'ok' | 'warning' | 'error' | 'loading';

export interface TicketManagerStatusSnapshot {
  backendMode?: BackendMode;
  connection?: ConnectionCheck;
  aiProviders: AiProvider[];
  defaultProvider: AiProvider | 'none';
  lastError?: string;
  isChecking: boolean;
}

export interface TicketManagerStatusPresentation {
  text: string;
  tooltipMarkdown: string;
  tone: StatusTone;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getBackendModeLabel(mode: BackendMode | undefined): string {
  switch (mode) {
    case 'jira':
      return 'Jira';
    case 'demo':
      return 'Demo';
    case 'file':
      return 'File';
    case 'livefolder':
      return 'Live Folder';
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    default:
      return 'Unconfigured';
  }
}

function getAiProviderLabels(providers: AiProvider[]): string[] {
  return providers.map(provider => AI_PROVIDER_LABELS[provider] ?? provider);
}

function getAiSummary(snapshot: TicketManagerStatusSnapshot): {
  shortLabel: string;
  detailLabel: string;
  tone: 'ok' | 'warning';
} {
  const labels = getAiProviderLabels(snapshot.aiProviders);
  if (labels.length === 0) {
    return {
      shortLabel: 'none',
      detailLabel: 'No AI provider configured.',
      tone: 'warning'
    };
  }

  if (
    snapshot.defaultProvider !== 'none' &&
    !snapshot.aiProviders.includes(snapshot.defaultProvider)
  ) {
    return {
      shortLabel: `${labels.length} configured`,
      detailLabel: `Default provider ${AI_PROVIDER_LABELS[snapshot.defaultProvider] ?? snapshot.defaultProvider} is selected but not configured.`,
      tone: 'warning'
    };
  }

  if (snapshot.defaultProvider !== 'none') {
    return {
      shortLabel: AI_PROVIDER_LABELS[snapshot.defaultProvider] ?? snapshot.defaultProvider,
      detailLabel: `Default provider: ${AI_PROVIDER_LABELS[snapshot.defaultProvider] ?? snapshot.defaultProvider}. Configured: ${labels.join(', ')}.`,
      tone: 'ok'
    };
  }

  return {
    shortLabel: labels.length === 1 ? labels[0] : `${labels.length} configured`,
    detailLabel:
      labels.length === 1
        ? `Configured provider: ${labels[0]}.`
        : `Configured providers: ${labels.join(', ')}.`,
    tone: 'ok'
  };
}

export function buildTicketManagerStatusPresentation(
  snapshot: TicketManagerStatusSnapshot
): TicketManagerStatusPresentation {
  const backendLabel = getBackendModeLabel(snapshot.backendMode);
  const aiSummary = getAiSummary(snapshot);

  let tone: StatusTone = 'ok';
  if (snapshot.isChecking) {
    tone = 'loading';
  } else if (snapshot.lastError || snapshot.connection?.status === 'error') {
    tone = 'error';
  } else if (
    !snapshot.backendMode ||
    snapshot.connection?.status === 'warning' ||
    aiSummary.tone === 'warning'
  ) {
    tone = 'warning';
  }

  const icon =
    tone === 'loading'
      ? '$(sync~spin)'
      : tone === 'error'
        ? '$(error)'
        : tone === 'warning'
          ? '$(warning)'
          : '$(check)';

  const connectionSummary = snapshot.isChecking
    ? 'Checking connection…'
    : snapshot.connection?.message ??
      (snapshot.backendMode ? 'Connection status not checked yet.' : 'Choose a backend to get started.');

  const tooltipLines = [
    '**Ticket Manager**',
    '',
    `Backend: **${escapeMarkdown(backendLabel)}**`,
    `Connection: ${escapeMarkdown(connectionSummary)}`,
    snapshot.connection?.serverName
      ? `Server: ${escapeMarkdown(snapshot.connection.serverName)}`
      : undefined,
    snapshot.connection?.projectCount !== undefined
      ? `Projects: ${snapshot.connection.projectCount}`
      : undefined,
    snapshot.connection?.toolCount !== undefined
      ? `Tools: ${snapshot.connection.toolCount}`
      : undefined,
    '',
    `AI: ${escapeMarkdown(aiSummary.detailLabel)}`,
    snapshot.lastError ? `Last error: ${escapeMarkdown(snapshot.lastError)}` : undefined,
    '',
    '[Configure AI](command:ticketManager.configureAi) | [Open Ticket Manager Settings](command:ticketManager.openSettings) | [Check Connection](command:ticketManager.checkConnection)'
  ].filter((line): line is string => line !== undefined);

  return {
    text: `${icon} Ticket Manager: ${backendLabel} • AI ${aiSummary.shortLabel}`,
    tooltipMarkdown: tooltipLines.join('\n'),
    tone
  };
}

export class TicketManagerStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private refreshVersion = 0;
  private snapshot: TicketManagerStatusSnapshot = {
    aiProviders: [],
    defaultProvider: 'none',
    isChecking: false
  };

  public constructor(
    private readonly configStore: AppConfigStore,
    private readonly backendService: IssueTrackerService
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Ticket Manager Status';
    this.item.command = 'ticketManager.openSettings';
    this.item.show();
    this.syncStaticState();
    this.render();
  }

  public async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    this.syncStaticState();

    if (!this.snapshot.backendMode) {
      this.snapshot.connection = undefined;
      this.snapshot.lastError = undefined;
      this.snapshot.isChecking = false;
      this.render();
      return;
    }

    this.snapshot.isChecking = true;
    this.render();

    try {
      const result = await this.backendService.checkConnection();
      if (version !== this.refreshVersion) {
        return;
      }
      this.recordConnectionResult(result);
    } catch (error) {
      if (version !== this.refreshVersion) {
        return;
      }
      this.snapshot.connection = {
        status: 'error',
        message: toErrorMessage(error),
        toolCount: 0
      };
      this.snapshot.lastError = toErrorMessage(error);
      this.snapshot.isChecking = false;
      this.render();
    }
  }

  public recordConnectionResult(result: ConnectionCheck): void {
    this.syncStaticState();
    this.snapshot.connection = result;
    this.snapshot.isChecking = false;
    this.snapshot.lastError = result.status === 'error' ? result.message : undefined;
    this.render();
  }

  public recordError(error: unknown): void {
    this.syncStaticState();
    this.snapshot.lastError = toErrorMessage(error);
    this.render();
  }

  public dispose(): void {
    this.item.dispose();
  }

  private syncStaticState(): void {
    this.snapshot.backendMode = this.configStore.getBackendMode();
    this.snapshot.aiProviders = this.configStore.getConfiguredAiProviders();
    this.snapshot.defaultProvider = this.configStore.getAiDefaultProvider();
  }

  private render(): void {
    const presentation = buildTicketManagerStatusPresentation(this.snapshot);
    const tooltip = new vscode.MarkdownString(presentation.tooltipMarkdown, true);
    tooltip.isTrusted = {
      enabledCommands: [
        'ticketManager.configureAi',
        'ticketManager.openSettings',
        'ticketManager.checkConnection'
      ]
    };

    this.item.text = presentation.text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      presentation.tone === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : presentation.tone === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }
}
