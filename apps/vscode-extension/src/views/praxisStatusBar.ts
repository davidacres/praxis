import * as vscode from 'vscode';
import type { AiSessionManager } from '@praxis/core';
import { AI_PROVIDER_LABELS } from '../ai/aiProviderSetup';
import type { IssueTrackerService } from '@praxis/core';
import type { BackendRouter } from '../backends/backendRouter';
import type { ConnectionStore } from '@praxis/core';
import { AppConfigStore } from '../config/jiraConfig';
import type { AiProvider, BackendMode, ConnectionCheck } from '@praxis/core';

type StatusTone = 'ok' | 'warning' | 'error' | 'loading';

/** Contributed product icon id from package.json → contributes.icons. */
export const PRAXIS_STATUS_BAR_ICON = 'praxis-ticket';

export interface PraxisStatusSnapshot {
  backendMode?: BackendMode;
  /** Human-readable label of the active connection (when multi-connection mode is active). */
  connectionLabel?: string;
  /** Number of configured ticket providers (connections). */
  providerCount?: number;
  connection?: ConnectionCheck;
  aiProviders: AiProvider[];
  activeProvider: AiProvider | 'none';
  activeSessionCount?: number;
  approvalSessionCount?: number;
  pausedSessionCount?: number;
  analysisEnabled?: boolean;
  analysisPromptConfigured?: boolean;
  analysisModel?: string;
  lastError?: string;
  isChecking: boolean;
}

export interface PraxisStatusPresentation {
  text: string;
  accessibilityLabel: string;
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
    case 'jiracloud':
      return 'Jira MCP';
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

function getProviderSummary(snapshot: PraxisStatusSnapshot): {
  shortLabel: string;
  detailLabel: string;
} {
  const count = snapshot.providerCount ?? 0;
  if (count === 0) {
    return {
      shortLabel: 'no providers',
      detailLabel: 'No providers configured.'
    };
  }

  const noun = count === 1 ? 'provider' : 'providers';
  return {
    shortLabel: `${count} ${noun}`,
    detailLabel: `Connected to ${count} ${noun}.`
  };
}

function getAiSummary(snapshot: PraxisStatusSnapshot): {
  shortLabel: string;
  detailLabel: string;
  tone: 'ok' | 'warning';
} {
  const active = snapshot.activeProvider;
  const activeLabel = active !== 'none' ? AI_PROVIDER_LABELS[active] ?? active : undefined;

  if (snapshot.aiProviders.length === 1 && activeLabel) {
    return {
      shortLabel: activeLabel,
      detailLabel: `Configured with ${activeLabel}.`,
      tone: 'ok'
    };
  }

  if (active !== 'none' && activeLabel) {
    return {
      shortLabel: activeLabel,
      detailLabel: `${activeLabel} is selected but not configured yet.`,
      tone: 'warning'
    };
  }

  return {
    shortLabel: 'no AI',
    detailLabel: 'AI not configured.',
    tone: 'warning'
  };
}

function getSessionAttentionSummary(snapshot: PraxisStatusSnapshot): {
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

function getAnalysisSummary(snapshot: PraxisStatusSnapshot): {
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

export function buildPraxisStatusPresentation(
  snapshot: PraxisStatusSnapshot
): PraxisStatusPresentation {
  const providerSummary = getProviderSummary(snapshot);
  const aiSummary = getAiSummary(snapshot);
  const sessionAttention = getSessionAttentionSummary(snapshot);
  const analysisSummary = getAnalysisSummary(snapshot);
  const providerCount = snapshot.providerCount ?? 0;

  let tone: StatusTone = 'ok';
  if (snapshot.isChecking) {
    tone = 'loading';
  } else if (snapshot.lastError || snapshot.connection?.status === 'error') {
    tone = 'error';
  } else if (
    providerCount === 0 ||
    snapshot.connection?.status === 'warning' ||
    aiSummary.tone === 'warning' ||
    analysisSummary.tone === 'warning' ||
    sessionAttention.hasAttention
  ) {
    tone = 'warning';
  }

  const toneIcon =
    tone === 'loading'
      ? '$(sync~spin)'
      : tone === 'error'
        ? '$(error)'
        : tone === 'warning'
          ? '$(warning)'
          : undefined;

  const providerLine = snapshot.isChecking
    ? 'Checking connections…'
    : providerSummary.detailLabel;

  const tooltipLines = [
    '**Praxis**',
    '',
    escapeMarkdown(providerLine),
    escapeMarkdown(aiSummary.detailLabel),
    `Analysis: ${escapeMarkdown(analysisSummary.detailLabel)}`,
    ...sessionAttention.detailLines.map(line => escapeMarkdown(line)),
    snapshot.lastError ? `Last error: ${escapeMarkdown(snapshot.lastError)}` : undefined,
    '',
    '[Open Sessions](command:praxis.activeSessions.focus) | [Configure AI](command:praxis.configureAi) | [Open Praxis Settings](command:praxis.openSettings) | [Check Connection](command:praxis.checkConnection)'
  ].filter((line): line is string => line !== undefined);

  const sessionAttentionSuffix = sessionAttention.shortLabel
    ? ` • ${sessionAttention.shortLabel}`
    : '';

  const accessibilityLabel = `${providerSummary.shortLabel} • ${aiSummary.shortLabel} • Analysis ${analysisSummary.shortLabel}${sessionAttentionSuffix}`;
  const text = toneIcon
    ? `$(${PRAXIS_STATUS_BAR_ICON}) ${toneIcon}`
    : `$(${PRAXIS_STATUS_BAR_ICON})`;

  return {
    text,
    accessibilityLabel,
    tooltipMarkdown: tooltipLines.join('\n'),
    tone
  };
}

export class PraxisStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshVersion = 0;
  private snapshot: PraxisStatusSnapshot = {
    aiProviders: [],
    activeProvider: 'none',
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
    this.item.name = 'Praxis Status';
    this.item.command = 'praxis.openSettings';
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
    this.snapshot.providerCount = this.connectionStore?.getConnections().length ?? 0;
    this.snapshot.aiProviders = this.configStore.getConfiguredAiProviders();
    this.snapshot.activeProvider = this.configStore.getActiveAiProvider();
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
    const presentation = buildPraxisStatusPresentation(this.snapshot);
    const tooltip = new vscode.MarkdownString(presentation.tooltipMarkdown, true);
    tooltip.isTrusted = {
      enabledCommands: [
        'praxis.activeSessions.focus',
        'praxis.configureAi',
        'praxis.openSettings',
        'praxis.checkConnection'
      ]
    };

    this.item.text = presentation.text;
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = {
      label: `Praxis: ${presentation.accessibilityLabel}`
    };
    this.item.backgroundColor =
      presentation.tone === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : presentation.tone === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }
}

