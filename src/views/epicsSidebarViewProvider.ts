import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { FilterStore } from '../state/filterStore';
import type { IssueFilters, IssueSummary } from '../types';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { renderIconButton } from './webviewToolbarIcons';

interface EpicsSidebarCallbacks {
  onSelectEpic: (issueKey: string, openFullPanel?: boolean) => Promise<void>;
  onCreateEpic: () => Promise<void>;
  onEditEpic: (issueKey: string) => Promise<void>;
  onSetDefaultEpic: (issueKey: string) => Promise<void>;
  onDeleteEpic: (issueKey: string) => Promise<void>;
  onSetSearchText?: (searchText: string) => Promise<void>;
  onSetStatuses?: (statuses: string[]) => Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
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
    case 'subtask':
    case 'sub-task':
      return 'task';
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
    case 'backlog':
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

export function buildEpicStatusMetadataFilters(filters: IssueFilters): IssueFilters {
  return {
    ...filters,
    statuses: [],
    issueTypes: [],
    searchText: '',
    assigneeMode: 'all',
    parentKey: undefined
  };
}

export class EpicsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedIssueKey?: string;
  private searchText = '';
  private statusOptions: string[] = [];
  private epics: IssueSummary[] = [];
  private errorMessage?: string;
  private defaultEpicKey?: string;
  private requestGeneration = 0;
  private supportingDataGeneration = 0;
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

  public setDefaultEpicKey(issueKey: string | undefined): void {
    this.defaultEpicKey = issueKey?.trim() || undefined;
    this.render();
  }

  public async setSearchText(searchText: string): Promise<void> {
    this.searchText = searchText.trim();
    await this.refresh();
  }

  public getSearchText(): string {
    return this.searchText;
  }

  public async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const generation = ++this.requestGeneration;
    const supportingGeneration = ++this.supportingDataGeneration;
    const filters = this.filterStore.getFilters();
    const epicStatuses = this.filterStore.getEpicStatuses();

    try {
      const epics = await this.backendService.getParentItems(
        {
          ...filters,
          statuses: epicStatuses,
          issueTypes: [],
          searchText: '',
          assigneeMode: 'all',
          parentKey: undefined
        },
        this.searchText || undefined
      );

      if (generation !== this.requestGeneration) {
        return;
      }

      const defaultEpicKey = this.defaultEpicKey;
      this.epics = defaultEpicKey
        ? [...epics].sort((left, right) => {
            const leftIsDefault = left.key === defaultEpicKey;
            const rightIsDefault = right.key === defaultEpicKey;
            if (leftIsDefault === rightIsDefault) {
              return 0;
            }
            return leftIsDefault ? -1 : 1;
          })
        : epics;
      this.errorMessage = undefined;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.epics = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }

    let statusOptions = unique([...epicStatuses, ...this.epics.map(epic => epic.status)]);
    try {
      const metadata = await this.backendService.getFilterMetadata(
        buildEpicStatusMetadataFilters(filters)
      );
      statusOptions = unique([...statusOptions, ...metadata.statuses]);
    } catch {
      statusOptions = unique([...epicStatuses, ...this.epics.map(epic => epic.status)]);
    }

    if (supportingGeneration !== this.supportingDataGeneration) {
      return;
    }

    this.statusOptions = statusOptions;
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

    if (type === 'setSearchText') {
      const searchText = typeof payload.searchText === 'string' ? payload.searchText : '';
      await this.setSearchText(searchText);
      await this.callbacks.onSetSearchText?.(searchText);
      return;
    }

    if (type === 'setStatuses') {
      const statuses = Array.isArray(payload.statuses)
        ? payload.statuses.filter((status): status is string => typeof status === 'string')
        : [];
      await this.callbacks.onSetStatuses?.(statuses);
      return;
    }

    if (type === 'createEpic') {
      await this.callbacks.onCreateEpic();
      return;
    }

    const issueKey = this.readIssueKey(payload);
    if (!issueKey) {
      return;
    }

    const handler = this.resolveIssueAction(type, issueKey, payload);
    if (handler) {
      await handler();
    }
  }

  private readIssueKey(payload: Record<string, unknown>): string | undefined {
    return typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
  }

  private resolveIssueAction(
    type: string,
    issueKey: string,
    payload: Record<string, unknown>
  ): (() => Promise<void>) | undefined {
    switch (type) {
      case 'selectEpic':
        return async () => this.callbacks.onSelectEpic(issueKey, Boolean(payload.openFullPanel));
      case 'editEpic':
        return async () => this.callbacks.onEditEpic(issueKey);
      case 'setDefaultEpic':
        return async () => this.callbacks.onSetDefaultEpic(issueKey);
      case 'deleteEpic':
        return async () => this.callbacks.onDeleteEpic(issueKey);
      default:
        return undefined;
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const nonce = createNonce();
    const content = this.renderContent();

    this.view.title = undefined;
    const epicCount = this.epics.length;
    this.view.description = String(epicCount);
    this.view.badge = undefined;

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
      .search-row {
        display: flex;
        width: 100%;
        flex-shrink: 0;
        box-sizing: border-box;
        padding: 8px 0 0;
        margin: 0;
      }
      .search-field {
        display: flex;
        flex: 1;
        min-width: 0;
        align-items: center;
        gap: 4px;
        box-sizing: border-box;
        padding: 0 8px 0 10px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-input-background);
      }
      .search-form {
        display: flex;
        flex: 1;
        min-width: 0;
      }
      .search-input {
        flex: 1;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 4px 7px 0;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--vscode-input-foreground);
        outline: none;
        font-size: 13px;
      }
      .search-input::placeholder {
        color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
      }
      .filter-wrap {
        position: relative;
        flex-shrink: 0;
        display: flex;
        align-items: center;
      }
      .filter-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 2;
        width: 220px;
        display: none;
        box-sizing: border-box;
        padding: 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-sideBar-background);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
      }
      .filter-menu.open {
        display: block;
      }
      .filter-title {
        margin: 0 0 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--vscode-descriptionForeground);
      }
      .filter-options {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 220px;
        overflow: auto;
      }
      .filter-option {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .filter-actions {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 10px;
      }
      .text-button {
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 6px;
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        padding: 5px 9px;
        cursor: pointer;
        font-size: 12px;
      }
      .text-button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
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
        padding: 4px 6px;
        border-radius: 2px;
        background: transparent;
        cursor: pointer;
      }
      .epic-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .epic-row.selected {
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      }
      .epic-row.default-epic {
        background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-textLink-foreground) 35%, transparent);
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
      .epic-row.default-epic .item-key {
        color: var(--vscode-textLink-foreground);
      }
      .epic-row.selected .item-meta {
        color: inherit;
        opacity: 0.8;
      }
      .link-pill {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.4;
        color: var(--vscode-textLink-foreground);
        background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 24%, transparent);
      }
      .context-menu {
        position: fixed;
        z-index: 3;
        min-width: 210px;
        display: none;
        flex-direction: column;
        box-sizing: border-box;
        border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
        border-radius: 6px;
        background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.22);
        overflow: hidden;
      }
      .context-menu.open {
        display: flex;
      }
      .context-menu button {
        border: none;
        background: transparent;
        color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
        text-align: left;
        padding: 8px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .context-menu button:hover {
        background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-menu-selectionForeground, var(--vscode-editor-foreground));
      }
      .context-menu button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .done .item-key,
      .done .item-summary,
      .done .item-meta {
        text-decoration: line-through;
        text-decoration-thickness: 1px;
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

      const filterButton = document.getElementById('filterButton');
      const filterMenu = document.getElementById('filterMenu');
      if (filterButton && filterMenu) {
        filterButton.addEventListener('click', event => {
          event.preventDefault();
          filterMenu.classList.toggle('open');
        });
        document.addEventListener('click', event => {
          if (!filterMenu.contains(event.target) && !filterButton.contains(event.target)) {
            filterMenu.classList.remove('open');
          }
        });
      }

      const searchForm = document.getElementById('searchForm');
      const searchInput = document.getElementById('searchInput');
      if (searchForm && searchInput) {
        searchForm.addEventListener('submit', event => {
          event.preventDefault();
          vscodeApi.postMessage({ type: 'setSearchText', searchText: searchInput.value || '' });
        });
      }

      const applyStatusesButton = document.getElementById('applyStatusesButton');
      if (applyStatusesButton) {
        applyStatusesButton.addEventListener('click', () => {
          const statuses = [...document.querySelectorAll('.filter-option input:checked')].map(input => input.value);
          vscodeApi.postMessage({ type: 'setStatuses', statuses });
          if (filterMenu) filterMenu.classList.remove('open');
        });
      }

      const clearStatusesButton = document.getElementById('clearStatusesButton');
      if (clearStatusesButton) {
        clearStatusesButton.addEventListener('click', () => {
          document.querySelectorAll('.filter-option input:checked').forEach(cb => cb.checked = false);
          vscodeApi.postMessage({ type: 'setStatuses', statuses: [] });
          if (searchInput) {
            searchInput.value = '';
            vscodeApi.postMessage({ type: 'setSearchText', searchText: '' });
          }
          if (filterMenu) filterMenu.classList.remove('open');
        });
      }

      const contextMenu = document.getElementById('epicContextMenu');
      const setDefaultEpicMenuItem = document.getElementById('setDefaultEpicMenuItem');
      let currentContextIssueKey;

      function closeContextMenu() {
        if (contextMenu) {
          contextMenu.classList.remove('open');
        }
        currentContextIssueKey = undefined;
      }

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
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          const issueKey = row.getAttribute('data-epic-key');
          if (!issueKey || !contextMenu || !setDefaultEpicMenuItem) {
            return;
          }

          currentContextIssueKey = issueKey;
          const isDefaultEpic = row.getAttribute('data-is-default') === 'true';
          setDefaultEpicMenuItem.disabled = isDefaultEpic;
          contextMenu.style.left = event.clientX + 'px';
          contextMenu.style.top = event.clientY + 'px';
          contextMenu.classList.add('open');
        });
      }

      if (setDefaultEpicMenuItem) {
        setDefaultEpicMenuItem.addEventListener('click', event => {
          event.stopPropagation();
          if (!currentContextIssueKey) {
            return;
          }
          vscodeApi.postMessage({ type: 'setDefaultEpic', issueKey: currentContextIssueKey });
          closeContextMenu();
        });
      }

      document.addEventListener('click', event => {
        if (!contextMenu) {
          return;
        }
        if (!contextMenu.contains(event.target)) {
          closeContextMenu();
        }
      });

      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          closeContextMenu();
        }
      });
    </script>
  </body>
</html>`;
  }

  private renderContent(): string {
    const epicStatuses = this.filterStore.getEpicStatuses();
    if (this.errorMessage) {
      return `${this.renderSearchRow(epicStatuses)}<div class="message error">${escapeHtml(this.errorMessage)}</div>`;
    }

    if (this.epics.length === 0) {
      if (this.searchText || epicStatuses.length > 0) {
        return `${this.renderSearchRow(epicStatuses)}<div class="message">No EPICs match the current filters.</div>`;
      }
      return `${this.renderSearchRow(epicStatuses)}<div class="message">No EPICs are available for the current project scope.</div>`;
    }

    return `${this.renderSearchRow(epicStatuses)}<div class="item-list">
      ${this.epics
        .map(epic => {
          const isDefaultEpic = this.defaultEpicKey === epic.key;
          const epicTitle = `${epic.key}: ${epic.summary}`;
          const epicProjectLabel = [
            epic.projectName ? `${epic.projectKey} • ${epic.projectName}` : epic.projectKey
          ]
            .filter(Boolean)
            .join(' • ');
          const classes = [
            'epic-row',
            this.selectedIssueKey === epic.key ? 'selected' : '',
            isDefaultEpic ? 'default-epic' : '',
            isDoneIssue(epic) ? 'done' : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `<div class="${classes}" data-epic-key="${escapeHtml(epic.key)}" data-is-default="${isDefaultEpic ? 'true' : 'false'}" title="${escapeHtml(epicTitle)}">
            <div class="row-main">
              <div class="row-left">
                <div class="item-key">${escapeHtml(epic.key)}</div>
                ${renderIssueTypeBadge(epic.issueType)}
                ${isDefaultEpic ? '<span class="link-pill">Default</span>' : ''}
                <div class="item-summary">${escapeHtml(epic.summary)}</div>
                <div class="item-meta">${escapeHtml(epicProjectLabel)}</div>
              </div>
              <div class="row-right">
                ${renderStatusBadge(epic.status)}
              </div>
            </div>
          </div>`;
        })
        .join('')}
    </div>
    <div class="context-menu" id="epicContextMenu">
      <button id="setDefaultEpicMenuItem" type="button">Set as default EPIC for this repo</button>
    </div>`;
  }

  private renderSearchRow(epicStatuses: string[]): string {
    return `<div class="search-row">
      <div class="search-field">
      <form class="search-form" id="searchForm">
        <input class="search-input" id="searchInput" type="search" placeholder="Search EPICs..." value="${escapeHtml(this.searchText)}" />
      </form>
      <div class="filter-wrap">
        ${renderIconButton('filterButton', 'Filter EPICs', 'filter')}
        <div class="filter-menu" id="filterMenu">
          <p class="filter-title">Status</p>
          <div class="filter-options">
            ${this.statusOptions.length > 0
              ? this.statusOptions
                  .map(
                    status => `<label class="filter-option">
                      <input type="checkbox" value="${escapeHtml(status)}" ${epicStatuses.includes(status) ? 'checked' : ''} />
                      <span>${escapeHtml(status)}</span>
                    </label>`
                  )
                  .join('')
              : '<div class="message">No statuses available.</div>'}
          </div>
          <div class="filter-actions">
            <button class="text-button" id="clearStatusesButton" type="button">Clear</button>
            <button class="text-button" id="applyStatusesButton" type="button">Apply</button>
          </div>
        </div>
      </div>
      </div>
    </div>`;
  }
}
