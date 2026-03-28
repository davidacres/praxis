import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { FilterStore } from '../state/filterStore';
import type { IssueSummary } from '../types';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { renderIconButton } from './webviewToolbarIcons';

interface EpicsSidebarCallbacks {
  onSelectEpic: (issueKey: string, openFullPanel?: boolean) => Promise<void>;
  onCreateEpic: () => Promise<void>;
  onEditEpic: (issueKey: string) => Promise<void>;
  onDeleteEpic: (issueKey: string) => Promise<void>;
}

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

function isDoneIssue(issue: IssueSummary): boolean {
  return (
    issue.statusCategory?.toLowerCase() === 'done' ||
    /^(done|closed|resolved)$/i.test(issue.status.trim())
  );
}

function getIssueTypeToken(issueType: string | undefined): string {
  const normalized = issueType?.trim().toLowerCase();
  switch (normalized) {
    case 'epic':
      return 'epic';
    case 'feature':
      return 'feature';
    case 'story':
      return 'story';
    case 'task':
      return 'task';
    case 'bug':
      return 'bug';
    default:
      return 'issue';
  }
}

function renderIssueTypeBadge(issueType: string | undefined): string {
  const label = issueType?.trim() || 'Issue';
  const token = getIssueTypeToken(label);
  return `<span class="type-badge type-badge--${token}">${escapeHtml(label)}</span>`;
}

function getStatusToken(status: string | undefined): string {
  const normalized = status?.trim().toLowerCase();
  switch (normalized) {
    case 'done':
    case 'closed':
    case 'resolved':
      return 'done';
    case 'in progress':
      return 'progress';
    case 'blocked':
      return 'blocked';
    case 'to do':
      return 'todo';
    default:
      return 'status';
  }
}

function renderStatusBadge(status: string | undefined): string {
  const label = status?.trim() || 'Unknown';
  return `<span class="type-badge type-badge--${getStatusToken(label)}">${escapeHtml(label)}</span>`;
}

export class EpicsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedIssueKey?: string;
  private epics: IssueSummary[] = [];
  private errorMessage?: string;
  private requestGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly filterStore: FilterStore,
    private readonly issuesProvider: IssuesTreeProvider,
    private readonly callbacks: EpicsSidebarCallbacks
  ) {
    this.disposables.push(
      this.filterStore.onDidChange(() => {
        void this.refresh();
      }),
      this.issuesProvider.onDidChangeTreeData(() => {
        void this.refresh();
      })
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
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
    if (!this.view) {
      return;
    }

    const generation = ++this.requestGeneration;
    const filters = this.filterStore.getFilters();

    try {
      const epics = await this.backendService.getParentItems(
        {
          ...filters,
          statuses: [],
          issueTypes: [],
          searchText: '',
          assigneeMode: 'all',
          parentKey: undefined
        },
        undefined
      );

      if (generation !== this.requestGeneration) {
        return;
      }

      this.epics = epics;
      this.errorMessage = undefined;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.epics = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }

    this.render();
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
    const type = typeof payload.type === 'string' ? payload.type : undefined;
    if (!type) {
      return;
    }

    switch (type) {
      case 'selectEpic': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onSelectEpic(issueKey, Boolean(payload.openFullPanel));
        }
        return;
      }
      case 'createEpic':
        await this.callbacks.onCreateEpic();
        return;
      case 'editEpic': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onEditEpic(issueKey);
        }
        return;
      }
      case 'deleteEpic': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onDeleteEpic(issueKey);
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

    const nonce = createNonce();
    const content = this.renderContent();

    this.view.title = `EPICs (${this.epics.length})`;

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
      }
      html, body {
        height: 100%;
      }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-sideBar-background);
      }
      .page {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 100%;
        padding: 0;
      }
      .item-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .epic-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        padding: 4px 0;
        border-radius: 0;
        background: transparent;
        cursor: pointer;
      }
      .epic-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .epic-row.selected {
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      }
      .row-main {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        min-height: 28px;
      }
      .row-left {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .row-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .item-key {
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
      }
      .type-badge {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: 1px 6px;
        border: 1px solid transparent;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.4;
      }
      .type-badge--epic {
        color: #d8b4fe;
        background: rgba(168, 85, 247, 0.16);
        border-color: rgba(168, 85, 247, 0.28);
      }
      .type-badge--feature {
        color: #fdba74;
        background: rgba(249, 115, 22, 0.16);
        border-color: rgba(249, 115, 22, 0.28);
      }
      .type-badge--story {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        border-color: rgba(59, 130, 246, 0.28);
      }
      .type-badge--task {
        color: #86efac;
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(34, 197, 94, 0.28);
      }
      .type-badge--bug {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.16);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .type-badge--issue {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .type-badge--todo {
        color: #c4b5fd;
        background: rgba(124, 58, 237, 0.16);
        border-color: rgba(124, 58, 237, 0.28);
      }
      .type-badge--progress {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        border-color: rgba(59, 130, 246, 0.28);
      }
      .type-badge--blocked {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.16);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .type-badge--done {
        color: #86efac;
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(34, 197, 94, 0.28);
      }
      .type-badge--status {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .item-summary {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .item-meta {
        flex-shrink: 0;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      .epic-row.selected .item-key {
        color: inherit;
      }
      .epic-row.selected .item-meta {
        color: inherit;
        opacity: 0.8;
      }
      .done .item-key,
      .done .item-summary,
      .done .item-meta {
        text-decoration: line-through;
        text-decoration-thickness: 1px;
      }
      .row-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--vscode-icon-foreground, var(--vscode-editor-foreground));
        cursor: pointer;
      }
      .row-actions .icon-button {
        width: 24px;
        height: 24px;
      }
      .icon-button:hover {
        border-color: var(--vscode-widget-border, transparent);
        background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      }
      .icon-button svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .message {
        padding: 10px 0;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${content}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();

      for (const row of document.querySelectorAll('[data-epic-key]')) {
        row.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'selectEpic', issueKey: row.getAttribute('data-epic-key') });
        });
        row.addEventListener('dblclick', () => {
          vscodeApi.postMessage({
            type: 'selectEpic',
            issueKey: row.getAttribute('data-epic-key'),
            openFullPanel: true
          });
        });
      }

      for (const button of document.querySelectorAll('[data-edit-epic-key]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'editEpic', issueKey: button.getAttribute('data-edit-epic-key') });
        });
      }

      for (const button of document.querySelectorAll('[data-delete-epic-key]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'deleteEpic', issueKey: button.getAttribute('data-delete-epic-key') });
        });
      }
    </script>
  </body>
</html>`;
  }

  private renderContent(): string {
    if (this.errorMessage) {
      return `<div class="message error">${escapeHtml(this.errorMessage)}</div>`;
    }

    if (this.epics.length === 0) {
      return '<div class="message">No EPICs are available for the current project scope.</div>';
    }

    return `<div class="item-list">
      ${this.epics
        .map(epic => {
          const classes = [
            'epic-row',
            this.selectedIssueKey === epic.key ? 'selected' : '',
            isDoneIssue(epic) ? 'done' : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `<div class="${classes}" data-epic-key="${escapeHtml(epic.key)}" title="${escapeHtml(`${epic.key}: ${epic.summary}`)}">
            <div class="row-main">
              <div class="row-left">
                <div class="item-key">${escapeHtml(epic.key)}</div>
                ${renderIssueTypeBadge(epic.issueType)}
                <div class="item-summary">${escapeHtml(epic.summary)}</div>
                <div class="item-meta">${escapeHtml(
                  [epic.projectName ? `${epic.projectKey} • ${epic.projectName}` : epic.projectKey]
                    .filter(Boolean)
                    .join(' • ')
                )}</div>
              </div>
              <div class="row-right">
                ${renderStatusBadge(epic.status)}
                <div class="row-actions">
                  ${renderIconButton(`editEpic-${epic.key}`, 'Edit EPIC', 'edit').replace(
                    'id="editEpic-' + epic.key + '"',
                    `id="editEpic-${epic.key}" data-edit-epic-key="${escapeHtml(epic.key)}"`
                  )}
                  ${renderIconButton(`deleteEpic-${epic.key}`, 'Delete EPIC', 'delete').replace(
                    'id="deleteEpic-' + epic.key + '"',
                    `id="deleteEpic-${epic.key}" data-delete-epic-key="${escapeHtml(epic.key)}"`
                  )}
                </div>
              </div>
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  }
}
