import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import { AI_PROVIDER_LABELS } from '../ai/aiProviderSetup';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { BackendRouter } from '../backends/backendRouter';
import type { ConnectionStore } from '../config/connectionStore';
import { AppConfigStore } from '../config/jiraConfig';
import type { AiProvider, BackendMode, ConnectionCheck } from '../types';

type StatusTone = 'ok' | 'warning' | 'error' | 'loading';

export interface TicketManagerStatusSnapshot {
  backendMode?: BackendMode;
  /** Human-readable label of the active connection (when multi-connection mode is active). */
  connectionLabel?: string;
  connection?: ConnectionCheck;
  aiProviders: AiProvider[];
  defaultProvider: AiProvider | 'none';
  activeSessionCount?: number;
  approvalSessionCount?: number;
  pausedSessionCount?: number;
  analysisEnabled?: boolean;
  analysisPromptConfigured?: boolean;
  analysisModel?: string;
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
      return 'Jira Cloud';
    case 'jiraapi':
      return 'Jira Cloud';
    case 'demo':
      return 'Demo';
    case 'livefolder':
      return 'Live Folder';
    case 'userworkspace':
      return 'User Workspace';
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

function getSessionAttentionSummary(snapshot: TicketManagerStatusSnapshot): {
  shortLabel?: string;
  detailLines: string[];
  hasAttention: boolean;
} {
  const activeSessionCount = snapshot.activeSessionCount ?? 0;
  const approvalSessionCount = snapshot.approvalSessionCount ?? 0;
  const pausedSessionCount = snapshot.pausedSessionCount ?? 0;

  const shortParts: string[] = [];
  if (approvalSessionCount > 0) {
    shortParts.push(
      `${approvalSessionCount} approval${approvalSessionCount === 1 ? '' : 's'}`
    );
  }
  if (pausedSessionCount > 0) {
    shortParts.push(`${pausedSessionCount} paused`);
  }

  const detailLines: string[] = [];
  if (activeSessionCount > 0) {
    detailLines.push(
      `Active sessions: ${activeSessionCount}`
    );
  }
  if (approvalSessionCount > 0) {
    detailLines.push(
      `Approval required: ${approvalSessionCount}`
    );
  }
  if (pausedSessionCount > 0) {
    detailLines.push(
      `Paused sessions: ${pausedSessionCount}`
    );
  }

  return {
    shortLabel: shortParts.length > 0 ? shortParts.join(' • ') : undefined,
    detailLines,
    hasAttention: approvalSessionCount > 0 || pausedSessionCount > 0
  };
}

function getAnalysisSummary(snapshot: TicketManagerStatusSnapshot): {
  shortLabel: string;
  detailLabel: string;
  tone: 'ok' | 'warning';
} {
  const analysisConfigured = snapshot.analysisEnabled === true;
  if (!analysisConfigured) {
    return {
      shortLabel: 'off',
      detailLabel: 'Analysis gate is disabled.',
      tone: 'ok'
    };
  }

  if (!snapshot.analysisPromptConfigured) {
    return {
      shortLabel: 'disabled',
      detailLabel: 'Analysis gate is enabled but disabled at runtime because Analysis Default Prompt is empty.',
      tone: 'warning'
    };
  }

  const model = snapshot.analysisModel?.trim() || 'workspace default';
  return {
    shortLabel: `ready (${model})`,
    detailLabel: `Analysis gate is enabled. Default model: ${model}.`,
    tone: 'ok'
  };
}

export function buildTicketManagerStatusPresentation(
  snapshot: TicketManagerStatusSnapshot
): TicketManagerStatusPresentation {
  const backendLabel = snapshot.connectionLabel ?? getBackendModeLabel(snapshot.backendMode);
  const aiSummary = getAiSummary(snapshot);
  const sessionAttention = getSessionAttentionSummary(snapshot);
  const analysisSummary = getAnalysisSummary(snapshot);

  let tone: StatusTone = 'ok';
  if (snapshot.isChecking) {
    tone = 'loading';
  } else if (snapshot.lastError || snapshot.connection?.status === 'error') {
    tone = 'error';
  } else if (
    !snapshot.backendMode ||
    snapshot.connection?.status === 'warning' ||
    aiSummary.tone === 'warning' ||
    analysisSummary.tone === 'warning' ||
    sessionAttention.hasAttention
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
    `Analysis: ${escapeMarkdown(analysisSummary.detailLabel)}`,
    ...sessionAttention.detailLines.map(line => escapeMarkdown(line)),
    snapshot.lastError ? `Last error: ${escapeMarkdown(snapshot.lastError)}` : undefined,
    '',
    '[Open Sessions](command:ticketManager.activeSessions.focus) | [Configure AI](command:ticketManager.configureAi) | [Open Ticket Manager Settings](command:ticketManager.openSettings) | [Check Connection](command:ticketManager.checkConnection)'
  ].filter((line): line is string => line !== undefined);

  const sessionAttentionSuffix = sessionAttention.shortLabel
    ? ` • ${sessionAttention.shortLabel}`
    : '';

  return {
    text: `${icon} Ticket Manager: ${backendLabel} • AI ${aiSummary.shortLabel} • Analysis ${analysisSummary.shortLabel}${sessionAttentionSuffix}`,
    tooltipMarkdown: tooltipLines.join('\n'),
    tone
  };
}

export class TicketManagerStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshVersion = 0;
  private snapshot: TicketManagerStatusSnapshot = {
    aiProviders: [],
    defaultProvider: 'none',
    isChecking: false
  };

  public constructor(
    private readonly configStore: AppConfigStore,
    private readonly backendService: IssueTrackerService,
    private readonly aiSessionManager?: AiSessionManager,
    private readonly connectionStore?: ConnectionStore,
    private readonly backendRouter?: BackendRouter
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Ticket Manager Status';
    this.item.command = 'ticketManager.openSettings';
    this.item.show();

    if (this.aiSessionManager) {
      this.disposables.push(
        this.aiSessionManager.onDidChangeSession(() => {
          this.syncSessionState();
          this.render();
        }),
        this.aiSessionManager.onDidChangeAgentSession(() => {
          this.syncSessionState();
          this.render();
        })
      );
    }

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

  /** Re-pull static state (active connection, backend mode, AI providers) and re-render without network I/O. */
  public resync(): void {
    this.syncStaticState();
    this.render();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }

  private syncStaticState(): void {
    this.snapshot.backendMode = this.configStore.getBackendMode();
    this.snapshot.connectionLabel = this.resolveActiveConnectionLabel();
    this.snapshot.aiProviders = this.configStore.getConfiguredAiProviders();
    this.snapshot.defaultProvider = this.configStore.getAiDefaultProvider();
    this.snapshot.analysisEnabled = this.configStore.getAiAnalysisEnabled();
    this.snapshot.analysisPromptConfigured =
      this.configStore.getAiAnalysisDefaultPrompt().trim().length > 0;
    this.snapshot.analysisModel = this.configStore.getAiAnalysisDefaultModel();
    this.syncSessionState();
  }

  private resolveActiveConnectionLabel(): string | undefined {
    const activeId = this.backendRouter?.getActiveConnectionId();
    if (!activeId || !this.connectionStore) {
      return undefined;
    }
    const connection = this.connectionStore.getConnection(activeId);
    if (!connection) {
      return undefined;
    }
    // Also update backendMode so other UI bits (icon tone, etc.) reflect
    // the active connection's backend rather than the legacy global mode.
    this.snapshot.backendMode = connection.mode;
    return connection.name;
  }

  private syncSessionState(): void {
    if (!this.aiSessionManager) {
      this.snapshot.activeSessionCount = 0;
      this.snapshot.approvalSessionCount = 0;
      this.snapshot.pausedSessionCount = 0;
      return;
    }

    const activeIssueKeys = new Set<string>(this.aiSessionManager.getActiveSessions().keys());
    let approvalSessionCount = 0;
    let pausedSessionCount = 0;

    for (const [issueKey, record] of this.aiSessionManager.getAllAgentSessions().entries()) {
      if (record.state !== 'completed' && record.state !== 'failed' && record.state !== 'aborted') {
        activeIssueKeys.add(issueKey);
      }
      if (record.state === 'awaiting_approval') {
        approvalSessionCount += 1;
      } else if (record.state === 'paused') {
        pausedSessionCount += 1;
      }
    }

    this.snapshot.activeSessionCount = activeIssueKeys.size;
    this.snapshot.approvalSessionCount = approvalSessionCount;
    this.snapshot.pausedSessionCount = pausedSessionCount;
  }

  private render(): void {
    const presentation = buildTicketManagerStatusPresentation(this.snapshot);
    const tooltip = new vscode.MarkdownString(presentation.tooltipMarkdown, true);
    tooltip.isTrusted = {
      enabledCommands: [
        'ticketManager.activeSessions.focus',
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
