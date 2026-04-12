import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { AgentSessionRecord } from '../ai/agentTypes';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AiAssignment, AiProvider } from '../types';

interface ActiveSessionsSidebarCallbacks {
  onOpenSession: (issueKey: string) => Promise<void>;
}

interface ActiveSessionListItem {
  issueKey: string;
  summary: string;
  providerLabel: string;
  stateLabel: string;
  stateToken: string;
  assigneeLabel: string;
  sessionId: string;
  assignedAt: string;
  hasLiveAgentSession: boolean;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  claude: 'Claude',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'GitHub Copilot SDK'
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isTerminalAgentState(state: string | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'aborted';
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return 'Unknown time';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function resolveProviderLabel(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): string {
  if (assignment?.label?.trim()) {
    return assignment.label.trim();
  }
  if (assignment) {
    return PROVIDER_LABELS[assignment.provider] ?? assignment.provider;
  }
  if (record) {
    return PROVIDER_LABELS['copilot-cli'];
  }
  return 'AI Session';
}

function resolveSessionState(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): { label: string; token: string } {
  if (record) {
    switch (record.state) {
      case 'planning':
        return { label: 'Planning', token: 'progress' };
      case 'awaiting_approval':
        return { label: 'Awaiting Approval', token: 'blocked' };
      case 'executing':
        return { label: 'Executing', token: 'progress' };
      case 'awaiting_input':
        return { label: 'Awaiting Input', token: 'blocked' };
      case 'completed':
        return { label: 'Completed', token: 'done' };
      case 'failed':
        return { label: 'Failed', token: 'blocked' };
      case 'aborted':
        return { label: 'Aborted', token: 'status' };
      default:
        return { label: 'Assigned', token: 'status' };
    }
  }

  switch (assignment?.status) {
    case 'completed':
      return { label: 'Completed', token: 'done' };
    case 'failed':
      return { label: 'Failed', token: 'blocked' };
    default:
      return { label: 'Assigned', token: 'progress' };
  }
}

export class ActiveSessionsSidebarViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private sessions: ActiveSessionListItem[] = [];
  private loading = false;
  private errorMessage?: string;
  private selectedIssueKey?: string;
  private generation = 0;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly aiSessionManager: AiSessionManager,
    private readonly callbacks: ActiveSessionsSidebarCallbacks
  ) {
    this.disposables.push(
      this.aiSessionManager.onDidChangeSession(() => {
        void this.refresh();
      }),
      this.aiSessionManager.onDidChangeAgentSession(() => {
        void this.refresh();
      })
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      this.disposables
    );
    void this.refresh();
  }

  public setSelectedIssueKey(issueKey: string | undefined): void {
    this.selectedIssueKey = issueKey;
    this.render();
  }

  public async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.errorMessage = undefined;
    this.render();

    try {
      const assignmentEntries = [...this.aiSessionManager.getActiveSessions().entries()];
      const activeAgentEntries = [...this.aiSessionManager.getAllAgentSessions().entries()].filter(
        ([, record]) => !isTerminalAgentState(record.state)
      );
      const issueKeys = [...new Set([
        ...assignmentEntries.map(([issueKey]) => issueKey),
        ...activeAgentEntries.map(([issueKey]) => issueKey)
      ])];

      const sessions = await Promise.all(
        issueKeys.map(async issueKey => {
          const assignment = this.aiSessionManager.getSession(issueKey);
          const record = this.aiSessionManager.getAgentSession(issueKey);
          let summary = 'Issue details unavailable';
          let assigneeLabel = assignment?.label?.trim() || resolveProviderLabel(assignment, record);
          try {
            const issue = await this.backendService.getIssue(issueKey);
            summary = issue.summary;
            assigneeLabel = issue.assignee?.trim() || assigneeLabel;
          } catch {
            // Keep fallback values so stale sessions can still be abandoned.
          }

          const presentation = resolveSessionState(assignment, record);
          return {
            issueKey,
            summary,
            providerLabel: resolveProviderLabel(assignment, record),
            stateLabel: presentation.label,
            stateToken: presentation.token,
            assigneeLabel,
            sessionId: assignment?.sessionId ?? record?.sessionId ?? issueKey,
            assignedAt: assignment?.assignedAt ?? record?.startedAt ?? '',
            hasLiveAgentSession: Boolean(record && !isTerminalAgentState(record.state))
          } satisfies ActiveSessionListItem;
        })
      );

      if (generation !== this.generation) {
        return;
      }

      this.sessions = sessions.sort((left, right) =>
        (right.assignedAt || '').localeCompare(left.assignedAt || '')
      );
      this.loading = false;
      this.errorMessage = undefined;
      this.render();
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.sessions = [];
      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  public dispose(): void {
    this.view = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const payload = message as Record<string, unknown>;
    switch (payload.type) {
      case 'openSession': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          this.selectedIssueKey = issueKey;
          this.render();
          await this.callbacks.onOpenSession(issueKey);
        }
        return;
      }
      case 'selectSession': {
        this.selectedIssueKey =
          typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        this.render();
        return;
      }
      case 'refresh':
        await this.refresh();
        return;
      default:
        return;
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const nonce = createNonce();
    this.view.description = this.sessions.length > 0 ? String(this.sessions.length) : undefined;
    this.view.badge = undefined;

    let content = '';
    if (this.errorMessage) {
      content = `<div class="message error">${escapeHtml(this.errorMessage)}</div>`;
    } else if (this.loading && this.sessions.length === 0) {
      content = '<div class="message">Loading active sessions...</div>';
    } else if (this.sessions.length === 0) {
      content = '<div class="message">No active AI sessions.</div>';
    } else {
      content = `<div class="item-list">
        ${this.sessions
          .map(session => {
            const classes = [
              'session-row',
              this.selectedIssueKey === session.issueKey ? 'selected' : ''
            ]
              .filter(Boolean)
              .join(' ');
            const meta = [
              `Assignee: ${session.assigneeLabel}`,
              session.hasLiveAgentSession ? 'Live agent activity' : 'Assignment only',
              formatDate(session.assignedAt)
            ].join(' • ');
            return `<div class="${classes}" data-issue-key="${escapeHtml(session.issueKey)}" title="${escapeHtml(`${session.issueKey}: ${session.summary}`)}">
              <div class="row-main">
                <div class="row-left">
                  <div class="item-key">${escapeHtml(session.issueKey)}</div>
                  <div class="item-summary">${escapeHtml(session.summary)}</div>
                </div>
                <div class="row-right">
                  <span class="pill pill--ai">${escapeHtml(session.providerLabel)}</span>
                  <span class="pill pill--${session.stateToken}">${escapeHtml(session.stateLabel)}</span>
                </div>
              </div>
              <div class="row-meta">${escapeHtml(meta)}</div>
            </div>`;
          })
          .join('')}
      </div>`;
    }

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root { color-scheme: light dark; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-sideBar-background);
      }
      .page { padding: 0; }
      .message {
        padding: 20px 16px;
        color: var(--vscode-descriptionForeground);
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
      .item-list {
        display: flex;
        flex-direction: column;
      }
      .session-row {
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
        cursor: pointer;
      }
      .session-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .session-row.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }
      .row-main {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }
      .row-left {
        min-width: 0;
        flex: 1;
      }
      .row-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .item-key {
        font-size: 11px;
        font-weight: 700;
        color: var(--vscode-textLink-foreground);
      }
      .item-summary {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.35;
        word-break: break-word;
      }
      .row-meta {
        margin-top: 6px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--vscode-panel-border);
        background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      }
      .pill--ai {
        border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 45%, var(--vscode-panel-border));
      }
      .pill--progress {
        border-color: color-mix(in srgb, var(--vscode-charts-blue) 55%, var(--vscode-panel-border));
      }
      .pill--done {
        border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 55%, var(--vscode-panel-border));
      }
      .pill--blocked {
        border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 55%, var(--vscode-panel-border));
      }
      .pill--status {
        border-color: var(--vscode-panel-border);
      }
    </style>
  </head>
  <body>
    <div class="page">${content}</div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      for (const row of document.querySelectorAll('.session-row')) {
        row.addEventListener('click', () => {
          const issueKey = row.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'selectSession', issueKey });
          }
        });
        row.addEventListener('dblclick', () => {
          const issueKey = row.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'openSession', issueKey });
          }
        });
      }
    </script>
  </body>
</html>`;
  }
}
