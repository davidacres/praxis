import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { AgentSessionRecord } from '../ai/agentTypes';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AiAssignment, AiProvider } from '../types';

interface ActiveSessionsSidebarCallbacks {
  onOpenSession: (issueKey: string) => Promise<void>;
  onResumeSession: (issueKey: string) => Promise<void>;
  onStartNewSession: (issueKey: string) => Promise<void>;
  onAbandonSession: (issueKey: string) => Promise<void>;
  onDeleteSession: (issueKey: string) => Promise<void>;
}

interface ActiveSessionListItem {
  issueKey: string;
  summary: string;
  provider?: AiProvider;
  providerLabel: string;
  stateLabel: string;
  stateToken: string;
  assigneeLabel: string;
  sessionId: string;
  assignedAt: string;
  hasLiveAgentSession: boolean;
  hasStoredAgentSession: boolean;
  canResumeSession: boolean;
  canStartNewSession: boolean;
  canDelete: boolean;
  requiresApproval: boolean;
  isPaused: boolean;
  attentionSummary?: string;
  sortRank: number;
  isActive: boolean;
}

type SessionFilter = 'active' | 'inactive' | 'all';

const PROVIDER_LABELS: Record<AiProvider, string> = {
  'vercel-gateway': 'Vercel AI Gateway'
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
  if (record?.provider) {
    return PROVIDER_LABELS[record.provider] ?? record.provider;
  }
  if (record) {
    return PROVIDER_LABELS['vercel-gateway'];
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
      case 'paused':
        return { label: 'Paused', token: 'status' };
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

function findLatestEventSummary(
  record: AgentSessionRecord | undefined,
  types: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (types.includes(event.type)) {
      return event.summary;
    }
  }
  return undefined;
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
  private shellInstalled = false;
  private filter: SessionFilter = 'active';

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly aiSessionManager: AiSessionManager,
    private readonly isLiveAgentSession: (issueKey: string) => boolean,
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
    this.shellInstalled = false;
    webviewView.onDidDispose(() => {
      this.shellInstalled = false;
    });
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

  public isViewVisible(): boolean {
    return this.view?.visible === true;
  }

  public async refresh(): Promise<void> {
    const generation = ++this.generation;
    // Only show the "Loading..." placeholder on the very first load.
    // Incremental refreshes keep the existing list visible so hovering/right-click
    // is not interrupted by a DOM rebuild.
    const isInitialLoad = this.sessions.length === 0 && !this.errorMessage;
    this.loading = isInitialLoad;
    this.errorMessage = undefined;
    if (isInitialLoad) {
      this.render();
    }

    try {
      const assignmentEntries = [...this.aiSessionManager.getAllSessions().entries()];
      const agentEntries = [...this.aiSessionManager.getAllAgentSessions().entries()];
      const issueKeys = [...new Set([
        ...assignmentEntries.map(([issueKey]) => issueKey),
        ...agentEntries.map(([issueKey]) => issueKey)
      ])];

      const sessions = await Promise.all(
        issueKeys.map(async issueKey => {
          const assignment = this.aiSessionManager.getSession(issueKey);
          const record = this.aiSessionManager.getAgentSession(issueKey);
          const hasLiveAgentSession = this.isLiveAgentSession(issueKey);
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
          const supportsCopilotSession =
            record?.sessionId != null ||
            assignment?.provider === 'vercel-gateway';
          const requiresApproval = record?.state === 'awaiting_approval';
          const isPaused = record?.state === 'paused';
          const attentionSummary = requiresApproval
            ? findLatestEventSummary(record, ['permission_requested']) ?? 'Approval is required to continue.'
            : isPaused
              ? findLatestEventSummary(record, ['info', 'warning']) ?? 'This session is paused. Resume it to continue.'
              : undefined;
          const sortRank = requiresApproval ? 0 : isPaused ? 1 : hasLiveAgentSession ? 2 : 3;
          const isActive = hasLiveAgentSession ||
            Boolean(record && !isTerminalAgentState(record.state) && record.state !== 'not_started') ||
            assignment?.status === 'active';
          return {
            issueKey,
            summary,
            provider: assignment?.provider,
            providerLabel: resolveProviderLabel(assignment, record),
            stateLabel: presentation.label,
            stateToken: presentation.token,
            assigneeLabel,
            sessionId: assignment?.sessionId ?? record?.sessionId ?? issueKey,
            assignedAt: assignment?.assignedAt ?? record?.startedAt ?? '',
            hasLiveAgentSession,
            hasStoredAgentSession: Boolean(record),
            canResumeSession: Boolean(record) && !hasLiveAgentSession,
            canStartNewSession: supportsCopilotSession,
            canDelete: !hasLiveAgentSession && (
              isTerminalAgentState(record?.state) ||
              record?.state === 'not_started' ||
              (!record && assignment?.status !== 'active')
            ),
            requiresApproval,
            isPaused,
            attentionSummary,
            sortRank,
            isActive
          } satisfies ActiveSessionListItem;
        })
      );

      if (generation !== this.generation) {
        return;
      }

      this.sessions = sessions.sort((left, right) => {
        if (left.sortRank !== right.sortRank) {
          return left.sortRank - right.sortRank;
        }
        return (right.assignedAt || '').localeCompare(left.assignedAt || '');
      });
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
      case 'setFilter': {
        const filterValue = typeof payload.filter === 'string' ? payload.filter : 'active';
        if (filterValue === 'active' || filterValue === 'inactive' || filterValue === 'all') {
          this.filter = filterValue;
          this.render();
        }
        return;
      }
      case 'resumeSession': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onResumeSession(issueKey);
        }
        return;
      }
      case 'startNewSession': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onStartNewSession(issueKey);
        }
        return;
      }
      case 'abandonSession': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onAbandonSession(issueKey);
        }
        return;
      }
      case 'deleteSession': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onDeleteSession(issueKey);
        }
        return;
      }
      default:
        return;
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const approvalCount = this.sessions.filter(session => session.requiresApproval).length;
    const pausedCount = this.sessions.filter(session => session.isPaused).length;
    const attentionCount = approvalCount + pausedCount;
    const descriptionParts: string[] = [];
    if (approvalCount > 0) {
      descriptionParts.push(`${approvalCount} waiting`);
    }
    if (pausedCount > 0) {
      descriptionParts.push(`${pausedCount} paused`);
    }
    this.view.description =
      descriptionParts.length > 0
        ? descriptionParts.join(' • ')
        : this.sessions.length > 0
          ? String(this.sessions.length)
          : undefined;
    this.view.badge =
      attentionCount > 0
        ? {
            value: attentionCount,
            tooltip:
              approvalCount > 0 && pausedCount > 0
                ? `${approvalCount} session(s) awaiting approval and ${pausedCount} paused session(s).`
                : approvalCount > 0
                  ? `${approvalCount} session(s) awaiting approval.`
                  : `${pausedCount} paused session(s).`
          }
        : undefined;

    if (!this.shellInstalled) {
      this.view.webview.html = this.buildShellHtml();
      this.shellInstalled = true;
    }

    void this.view.webview.postMessage({
      type: 'update',
      payload: {
        loading: this.loading,
        errorMessage: this.errorMessage,
        filter: this.filter,
        selectedIssueKey: this.selectedIssueKey,
        sessions: this.sessions.map(session => ({
          issueKey: session.issueKey,
          summary: session.summary,
          providerLabel: session.providerLabel,
          stateLabel: session.stateLabel,
          stateToken: session.stateToken,
          assigneeLabel: session.assigneeLabel,
          assignedAt: session.assignedAt,
          assignedAtLabel: formatDate(session.assignedAt),
          hasLiveAgentSession: session.hasLiveAgentSession,
          hasStoredAgentSession: session.hasStoredAgentSession,
          canResumeSession: session.canResumeSession,
          canStartNewSession: session.canStartNewSession,
          canDelete: session.canDelete,
          requiresApproval: session.requiresApproval,
          isPaused: session.isPaused,
          attentionSummary: session.attentionSummary,
          isActive: session.isActive
        }))
      }
    });
  }

  private buildShellHtml(): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
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
      .filter-bar {
        display: flex;
        gap: 4px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      }
      .filter-btn {
        appearance: none;
        border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground));
        border-radius: 4px;
        padding: 3px 10px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .filter-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      }
      .filter-btn.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
      }
      .item-list {
        display: flex;
        flex-direction: column;
      }
      .session-row {
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
      }
      .session-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .session-row.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }
      .session-row.needs-attention {
        border-left: 3px solid var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
        padding-left: 9px;
      }
      .session-row.is-paused {
        border-left: 3px solid var(--vscode-textPreformat-foreground, var(--vscode-symbolIcon-colorForeground));
        padding-left: 9px;
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
      .delete-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        border-radius: 4px;
        color: var(--vscode-descriptionForeground);
        opacity: 0;
        transition: opacity 0.15s, color 0.15s;
      }
      .session-row:hover .delete-btn { opacity: 1; }
      .delete-btn:hover {
        color: var(--vscode-errorForeground);
        background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
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
      .row-alert {
        margin-top: 8px;
        padding: 7px 9px;
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.4;
        border: 1px solid var(--vscode-panel-border);
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      }
      .row-alert--approval {
        border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 60%, var(--vscode-panel-border));
        background: color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, var(--vscode-editor-background));
      }
      .row-alert--paused {
        border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 55%, var(--vscode-panel-border));
        background: color-mix(in srgb, var(--vscode-descriptionForeground) 8%, var(--vscode-editor-background));
      }
      .pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 500;
        border: 1px solid transparent;
        background: transparent;
      }
      .pill--ai {
        color: #93c5fd;
        background: rgba(96, 165, 250, 0.1);
        border-color: rgba(96, 165, 250, 0.2);
      }
      .pill--progress {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.1);
        border-color: rgba(59, 130, 246, 0.2);
      }
      .pill--done {
        color: #86efac;
        background: rgba(34, 197, 94, 0.1);
        border-color: rgba(34, 197, 94, 0.2);
      }
      .pill--blocked {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.2);
      }
      .pill--status {
        color: #a1a1aa;
        background: rgba(161, 161, 170, 0.1);
        border-color: rgba(161, 161, 170, 0.2);
      }
      .session-context-menu {
        position: fixed;
        min-width: 190px;
        display: flex;
        flex-direction: column;
        padding: 6px;
        border-radius: 8px;
        border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
        background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        z-index: 1000;
      }
      .session-context-menu[hidden] {
        display: none;
      }
      .session-context-menu-item {
        appearance: none;
        border: none;
        background: transparent;
        color: inherit;
        text-align: left;
        border-radius: 6px;
        padding: 7px 10px;
        font: inherit;
        cursor: pointer;
      }
      .session-context-menu-item:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .session-context-menu-item--danger { color: var(--vscode-errorForeground); }
      .session-context-menu-item--danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
    </style>
  </head>
  <body>
    <div id="listContainer" class="page"><div class="message">Loading sessions...</div></div>
    <div id="sessionContextMenu" class="session-context-menu" hidden role="menu" aria-label="Session actions">
      <button type="button" class="session-context-menu-item" role="menuitem" data-session-menu-action="openSession">Open Session</button>
      <button type="button" class="session-context-menu-item" role="menuitem" data-session-menu-action="resumeSession">Resume Session</button>
      <button type="button" class="session-context-menu-item" role="menuitem" data-session-menu-action="startNewSession">Start New Session</button>
      <button type="button" class="session-context-menu-item" role="menuitem" data-session-menu-action="abandonSession">Abandon Session</button>
      <button type="button" class="session-context-menu-item session-context-menu-item--danger" role="menuitem" data-session-menu-action="deleteSession">Delete Session</button>
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      const listContainer = document.getElementById('listContainer');
      const sessionContextMenu = document.getElementById('sessionContextMenu');
      const resumeMenuItem = sessionContextMenu?.querySelector('[data-session-menu-action="resumeSession"]');
      const startNewMenuItem = sessionContextMenu?.querySelector('[data-session-menu-action="startNewSession"]');
      const deleteMenuItem = sessionContextMenu?.querySelector('[data-session-menu-action="deleteSession"]');

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function hideSessionMenu() {
        if (sessionContextMenu) {
          sessionContextMenu.hidden = true;
        }
      }

      function renderList(state) {
        if (!listContainer) return;
        const filter = state.filter || 'active';
        const filterBar = '<div class="filter-bar">'
          + '<button type="button" class="filter-btn' + (filter === 'active' ? ' active' : '') + '" data-filter="active">Active</button>'
          + '<button type="button" class="filter-btn' + (filter === 'inactive' ? ' active' : '') + '" data-filter="inactive">Inactive</button>'
          + '<button type="button" class="filter-btn' + (filter === 'all' ? ' active' : '') + '" data-filter="all">All</button>'
          + '</div>';
        if (state.errorMessage) {
          listContainer.innerHTML = filterBar + '<div class="message error">' + escapeHtml(state.errorMessage) + '</div>';
          return;
        }
        if (state.loading && (!state.sessions || state.sessions.length === 0)) {
          listContainer.innerHTML = filterBar + '<div class="message">Loading sessions...</div>';
          return;
        }
        const filtered = (state.sessions || []).filter(session => {
          if (filter === 'active') return session.isActive;
          if (filter === 'inactive') return !session.isActive;
          return true;
        });
        if (filtered.length === 0) {
          const emptyLabel = filter === 'active'
            ? 'No active AI sessions.'
            : filter === 'inactive'
              ? 'No inactive sessions.'
              : 'No AI sessions.';
          listContainer.innerHTML = filterBar + '<div class="message">' + emptyLabel + '</div>';
          return;
        }
        const rows = filtered.map(session => {
          const classes = ['session-row'];
          if (state.selectedIssueKey === session.issueKey) classes.push('selected');
          if (session.requiresApproval) classes.push('needs-attention');
          if (session.isPaused) classes.push('is-paused');
          const metaParts = [
            'Assignee: ' + session.assigneeLabel,
            session.hasLiveAgentSession
              ? 'Live agent activity'
              : session.hasStoredAgentSession
                ? 'Stored session available'
                : 'Assignment only',
            session.assignedAtLabel
          ];
          const attentionBanner = session.attentionSummary
            ? '<div class="row-alert row-alert--' + (session.requiresApproval ? 'approval' : 'paused') + '">' + escapeHtml(session.attentionSummary) + '</div>'
            : '';
          const deleteIcon = session.canDelete
            ? '<button class="delete-btn" data-delete-key="' + escapeHtml(session.issueKey) + '" title="Delete session" aria-label="Delete session for ' + escapeHtml(session.issueKey) + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg></button>'
            : '';
          return '<div class="' + classes.join(' ') + '"'
            + ' data-issue-key="' + escapeHtml(session.issueKey) + '"'
            + ' data-can-resume="' + (session.canResumeSession ? 'true' : 'false') + '"'
            + ' data-can-start-new="' + (session.canStartNewSession ? 'true' : 'false') + '"'
            + ' data-can-delete="' + (session.canDelete ? 'true' : 'false') + '"'
            + ' title="' + escapeHtml(session.issueKey + ': ' + session.summary) + '">'
            + '<div class="row-main">'
            + '<div class="row-left">'
            + '<div class="item-key">' + escapeHtml(session.issueKey) + '</div>'
            + '<div class="item-summary">' + escapeHtml(session.summary) + '</div>'
            + '</div>'
            + '<div class="row-right">'
            + deleteIcon
            + '<span class="pill pill--ai">' + escapeHtml(session.providerLabel) + '</span>'
            + '<span class="pill pill--' + escapeHtml(session.stateToken) + '">' + escapeHtml(session.stateLabel) + '</span>'
            + '</div>'
            + '</div>'
            + attentionBanner
            + '<div class="row-meta">' + escapeHtml(metaParts.join(' • ')) + '</div>'
            + '</div>';
        }).join('');
        listContainer.innerHTML = filterBar + '<div class="item-list">' + rows + '</div>';
      }

      // Delegate interactions so they survive list re-renders.
      if (listContainer) {
        listContainer.addEventListener('click', event => {
          const deleteButton = event.target instanceof Element ? event.target.closest('.delete-btn') : null;
          if (deleteButton) {
            const issueKey = deleteButton.getAttribute('data-delete-key');
            if (issueKey) {
              vscodeApi.postMessage({ type: 'deleteSession', issueKey });
            }
            return;
          }
          const filterButton = event.target instanceof Element ? event.target.closest('.filter-btn') : null;
          if (filterButton) {
            const filter = filterButton.getAttribute('data-filter');
            if (filter) {
              vscodeApi.postMessage({ type: 'setFilter', filter });
            }
            return;
          }
          const row = event.target instanceof Element ? event.target.closest('.session-row') : null;
          if (!row) return;
          const issueKey = row.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'selectSession', issueKey });
          }
        });
        listContainer.addEventListener('dblclick', event => {
          const row = event.target instanceof Element ? event.target.closest('.session-row') : null;
          if (!row) return;
          const issueKey = row.getAttribute('data-issue-key');
          if (issueKey) {
            vscodeApi.postMessage({ type: 'openSession', issueKey });
          }
        });
      }

      if (sessionContextMenu) {
        sessionContextMenu.addEventListener('click', event => event.stopPropagation());
        sessionContextMenu.addEventListener('contextmenu', event => event.preventDefault());
        sessionContextMenu.addEventListener('click', event => {
          const target = event.target instanceof Element
            ? event.target.closest('[data-session-menu-action]')
            : null;
          if (!target) {
            return;
          }
          const action = target.getAttribute('data-session-menu-action');
          const issueKey = sessionContextMenu.dataset.issueKey;
          hideSessionMenu();
          if (action && issueKey) {
            vscodeApi.postMessage({ type: action, issueKey });
          }
        });
        document.addEventListener('click', hideSessionMenu);
        document.addEventListener('contextmenu', event => {
          const row = event.target instanceof Element ? event.target.closest('.session-row') : null;
          if (!row) {
            hideSessionMenu();
            return;
          }
          event.preventDefault();
          const issueKey = row.getAttribute('data-issue-key');
          if (!issueKey) {
            return;
          }
          const canResume = row.getAttribute('data-can-resume') === 'true';
          const canStartNew = row.getAttribute('data-can-start-new') === 'true';
          const canDelete = row.getAttribute('data-can-delete') === 'true';
          sessionContextMenu.dataset.issueKey = issueKey;
          if (resumeMenuItem) {
            resumeMenuItem.hidden = !canResume;
          }
          if (startNewMenuItem) {
            startNewMenuItem.hidden = !canStartNew;
          }
          if (deleteMenuItem) {
            deleteMenuItem.hidden = !canDelete;
          }
          sessionContextMenu.style.left = event.clientX + 'px';
          sessionContextMenu.style.top = event.clientY + 'px';
          sessionContextMenu.hidden = false;
          requestAnimationFrame(() => {
            const bounds = sessionContextMenu.getBoundingClientRect();
            let left = parseFloat(sessionContextMenu.style.left) || 0;
            let top = parseFloat(sessionContextMenu.style.top) || 0;
            if (left + bounds.width > window.innerWidth - 6) {
              left = window.innerWidth - bounds.width - 6;
            }
            if (top + bounds.height > window.innerHeight - 6) {
              top = window.innerHeight - bounds.height - 6;
            }
            sessionContextMenu.style.left = Math.max(6, left) + 'px';
            sessionContextMenu.style.top = Math.max(6, top) + 'px';
          });
        });
      }

      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'update' || !msg.payload) return;
        renderList(msg.payload);
      });
    </script>
  </body>
</html>`;
  }
}
