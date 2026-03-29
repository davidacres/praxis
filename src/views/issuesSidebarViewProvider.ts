import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { FilterStore } from '../state/filterStore';
import type { BackendMode, IssueFilters, IssueSummary } from '../types';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { renderIconButton } from './webviewToolbarIcons';

interface IssuesSidebarCallbacks {
  onSelectIssue: (issueKey: string, openFullPanel?: boolean) => Promise<void>;
  onEditIssue: (issueKey: string) => Promise<void>;
  onDeleteIssue: (issueKey: string) => Promise<void>;
  onSetSearchText?: (searchText: string) => Promise<void>;
  onSetStatuses?: (statuses: string[]) => Promise<void>;
  onLoadMore: () => Promise<void>;
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

function renderAssignmentBadge(issue: IssueSummary): string {
  const assignee = issue.assignee?.trim();
  const assigned = Boolean(assignee);
  const label = assigned ? assignee! : 'Unassigned';
  const token = assigned ? 'assigned' : 'unassigned';
  const title = assigned ? `Assigned to ${assignee}` : 'Unassigned';
  return `<span class="type-badge type-badge--${token}" title="${escapeHtml(title)}">${label}</span>`;
}

export class IssuesSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedIssueKey?: string;
  private statusOptions: string[] = [];
  private supportingDataGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private setupStep: 0 | 1 = 0;
  private setupMode: string | undefined;
  private setupFields: Record<string, string> = {};

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly filterStore: FilterStore,
    private readonly issuesProvider: IssuesTreeProvider,
    private readonly callbacks: IssuesSidebarCallbacks,
    private readonly getBackendMode: () => BackendMode | undefined
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

    const generation = ++this.supportingDataGeneration;
    const filters = this.filterStore.getFilters();
    const snapshot = this.issuesProvider.getSnapshot();

    let statusOptions = unique([...filters.statuses, ...snapshot.issues.map(issue => issue.status)]);
    try {
      const metadata = await this.backendService.getFilterMetadata({
        ...filters,
        statuses: [],
        issueTypes: []
      });
      statusOptions = unique([...statusOptions, ...metadata.statuses]);
    } catch {
      statusOptions = unique([...filters.statuses, ...snapshot.issues.map(issue => issue.status)]);
    }

    if (generation !== this.supportingDataGeneration) {
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

    switch (type) {
      case 'selectIssue': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (!issueKey) {
          return;
        }
        await this.callbacks.onSelectIssue(issueKey, Boolean(payload.openFullPanel));
        return;
      }
      case 'setSearchText': {
        const searchText = typeof payload.searchText === 'string' ? payload.searchText : '';
        await this.callbacks.onSetSearchText?.(searchText);
        return;
      }
      case 'setStatuses': {
        const statuses = Array.isArray(payload.statuses)
          ? payload.statuses.filter((status): status is string => typeof status === 'string')
          : [];
        await this.callbacks.onSetStatuses?.(statuses);
        return;
      }
      case 'editIssue': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onEditIssue(issueKey);
        }
        return;
      }
      case 'deleteIssue': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onDeleteIssue(issueKey);
        }
        return;
      }
      case 'loadMore':
        await this.callbacks.onLoadMore();
        return;
      case 'setup:selectMode': {
        const mode = typeof payload.mode === 'string' ? payload.mode : undefined;
        if (mode) {
          this.setupMode = mode;
          this.setupStep = 1;
          if (mode === 'github' && !this.setupFields.githubUrl) {
            this.setupFields.githubUrl = 'https://api.github.com';
          }
          if (mode === 'gitlab' && !this.setupFields.gitlabConnectionType) {
            this.setupFields.gitlabConnectionType = 'api';
          }
          if (mode === 'jira' && !this.setupFields.jiraConnectionType) {
            this.setupFields.jiraConnectionType = 'stdio';
          }
          this.render();
        }
        return;
      }
      case 'setup:back': {
        this.setupStep = 0;
        this.render();
        return;
      }
      case 'setup:updateField': {
        const field = typeof payload.field === 'string' ? payload.field : undefined;
        const value = typeof payload.value === 'string' ? payload.value : '';
        if (field) {
          this.setupFields[field] = value;
          if (field === 'gitlabConnectionType' || field === 'jiraConnectionType') {
            this.render();
          }
        }
        return;
      }
      case 'setup:browse': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSON files': ['json', 'jsonc'], 'All files': ['*'] },
          title: 'Select Plan File'
        });
        if (uris?.[0]) {
          const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
          this.setupFields.planFilePath = wsFolder
            ? vscode.workspace.asRelativePath(uris[0], false)
            : uris[0].fsPath;
          this.render();
        }
        return;
      }
      case 'setup:save': {
        await this.saveSetupConfiguration();
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

    if (!this.getBackendMode()) {
      this.renderSetupView();
      return;
    }

    const filters = this.filterStore.getFilters();
    const snapshot = this.issuesProvider.getSnapshot();
    const nonce = createNonce();
    const issuesSection = this.renderIssuesSection(snapshot, filters);

    this.view.title = undefined;
    this.view.description = String(snapshot.issues.length);
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
      .section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
        min-height: 0;
      }
      .block-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0;
        user-select: none;
      }
      .block-header-chevron {
        flex-shrink: 0;
        font-size: 10px;
        line-height: 1;
        color: var(--vscode-descriptionForeground);
      }
      .block-header-label {
        flex: 1;
        min-width: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--vscode-sideBarTitle-foreground, var(--vscode-editor-foreground));
      }
      .block-header-count {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
      }
      .item-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .issue-row {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 4px 6px;
        border-radius: 2px;
        background: transparent;
        cursor: pointer;
      }
      .issue-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .issue-row.selected {
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
      .type-badge--assigned,
      .type-badge--unassigned {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .item-summary {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .issue-row.selected .item-key {
        color: inherit;
      }
      .row-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .row-actions .icon-button {
        width: 24px;
        height: 24px;
      }
      .done .item-key,
      .done .item-summary {
        text-decoration: line-through;
        text-decoration-thickness: 1px;
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
      .load-more {
        align-self: flex-start;
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${issuesSection}
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
          vscodeApi.postMessage({ type: 'setStatuses', statuses: [] });
          if (filterMenu) filterMenu.classList.remove('open');
        });
      }

      const loadMoreButton = document.getElementById('loadMoreButton');
      if (loadMoreButton) {
        loadMoreButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'loadMore' });
        });
      }

      for (const row of document.querySelectorAll('[data-issue-key]')) {
        row.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'selectIssue', issueKey: row.getAttribute('data-issue-key') });
        });
        row.addEventListener('dblclick', () => {
          vscodeApi.postMessage({ type: 'selectIssue', issueKey: row.getAttribute('data-issue-key'), openFullPanel: true });
        });
      }

      for (const button of document.querySelectorAll('[data-edit-issue-key]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'editIssue', issueKey: button.getAttribute('data-edit-issue-key') });
        });
      }

      for (const button of document.querySelectorAll('[data-delete-issue-key]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'deleteIssue', issueKey: button.getAttribute('data-delete-issue-key') });
        });
      }
    </script>
  </body>
</html>`;
  }

  private renderSetupView(): void {
    if (!this.view) {
      return;
    }

    const nonce = createNonce();
    const body = this.setupStep === 0 ? this.renderSetupStep0() : this.renderSetupStep1();

    this.view.title = undefined;
    this.view.description = undefined;
    this.view.badge = undefined;

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
        font-size: 13px;
      }
      .setup-page {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 8px;
        min-height: 100%;
      }
      .setup-title {
        margin: 0 0 4px;
        font-size: 13px;
        font-weight: 700;
        color: var(--vscode-sideBarTitle-foreground, var(--vscode-editor-foreground));
      }
      .setup-subtitle {
        margin: 0 0 8px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .mode-card {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        text-align: left;
      }
      .mode-card:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
      }
      .mode-card-emoji {
        font-size: 20px;
        line-height: 1;
        flex-shrink: 0;
      }
      .mode-card-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .mode-card-title {
        font-size: 13px;
        font-weight: 600;
      }
      .mode-card-desc {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 6px;
      }
      .form-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--vscode-editor-foreground);
      }
      .form-input {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-family: var(--vscode-font-family);
        font-size: 13px;
        outline: none;
      }
      .form-input:focus {
        border-color: var(--vscode-focusBorder);
      }
      .form-input::placeholder {
        color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
      }
      .form-help {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin: 0;
      }
      .form-row {
        display: flex;
        gap: 6px;
        align-items: flex-end;
      }
      .form-row .form-group { flex: 1; margin-bottom: 0; }
      .radio-group {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
      }
      .radio-group label {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }
      .setup-info {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        padding: 10px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 6px;
        margin: 4px 0;
      }
      .btn-row {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }
      .btn {
        flex: 1;
        box-sizing: border-box;
        padding: 7px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        font-family: var(--vscode-font-family);
        font-size: 13px;
        cursor: pointer;
        text-align: center;
      }
      .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .btn-primary:hover {
        background: var(--vscode-button-hoverBackground);
      }
      .btn-secondary {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      }
      .btn-secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      }
      .btn-browse {
        flex: none;
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <div class="setup-page">
      ${body}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();

      document.addEventListener('click', e => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (action === 'selectMode') {
          vscodeApi.postMessage({ type: 'setup:selectMode', mode: target.dataset.mode });
        } else if (action === 'back') {
          vscodeApi.postMessage({ type: 'setup:back' });
        } else if (action === 'save') {
          vscodeApi.postMessage({ type: 'setup:save' });
        } else if (action === 'browse') {
          vscodeApi.postMessage({ type: 'setup:browse' });
        }
      });

      document.addEventListener('input', e => {
        if (e.target.dataset && e.target.dataset.field) {
          vscodeApi.postMessage({ type: 'setup:updateField', field: e.target.dataset.field, value: e.target.value });
        }
      });

      document.addEventListener('change', e => {
        if (e.target.dataset && e.target.dataset.field) {
          vscodeApi.postMessage({ type: 'setup:updateField', field: e.target.dataset.field, value: e.target.value });
        }
      });
    </script>
  </body>
</html>`;
  }

  private renderSetupStep0(): string {
    const cards: Array<{ mode: string; emoji: string; title: string; desc: string }> = [
      { mode: 'file', emoji: '🗂️', title: 'Plan File', desc: 'Manage tickets from a local plan file' },
      { mode: 'github', emoji: '🐙', title: 'GitHub', desc: 'Connect to GitHub repositories' },
      { mode: 'gitlab', emoji: '🦊', title: 'GitLab', desc: 'Connect to a GitLab instance' },
      { mode: 'jira', emoji: '🔗', title: 'Jira', desc: 'Connect to Jira via MCP server' },
      { mode: 'demo', emoji: '🎭', title: 'Demo', desc: 'Try with sample data' }
    ];

    const cardHtml = cards
      .map(
        c => `<div class="mode-card" data-action="selectMode" data-mode="${escapeHtml(c.mode)}">
        <span class="mode-card-emoji">${c.emoji}</span>
        <div class="mode-card-text">
          <span class="mode-card-title">${escapeHtml(c.title)}</span>
          <span class="mode-card-desc">${escapeHtml(c.desc)}</span>
        </div>
      </div>`
      )
      .join('');

    return `<p class="setup-title">Configure Project</p>
      <p class="setup-subtitle">Choose how to manage your tickets</p>
      ${cardHtml}`;
  }

  private renderSetupStep1(): string {
    let fields = '';

    switch (this.setupMode) {
      case 'file':
        fields = `<div class="form-row">
          <div class="form-group">
            <label class="form-label">Plan file path</label>
            <input class="form-input" data-field="planFilePath" type="text"
              placeholder="ticket-plan.jsonc"
              value="${escapeHtml(this.setupFields.planFilePath ?? '')}" />
          </div>
          <button class="btn btn-secondary btn-browse" data-action="browse" type="button">Browse…</button>
        </div>`;
        break;
      case 'github':
        fields = `<div class="form-group">
            <label class="form-label">API URL</label>
            <input class="form-input" data-field="githubUrl" type="url"
              placeholder="https://api.github.com"
              value="${escapeHtml(this.setupFields.githubUrl ?? 'https://api.github.com')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Personal Access Token</label>
            <input class="form-input" data-field="githubPat" type="password"
              placeholder="ghp_..."
              value="${escapeHtml(this.setupFields.githubPat ?? '')}" />
            <p class="form-help">Create a token at github.com/settings/tokens</p>
          </div>
          <div class="form-group">
            <label class="form-label">Owner</label>
            <input class="form-input" data-field="githubOwner" type="text"
              placeholder="username or org"
              value="${escapeHtml(this.setupFields.githubOwner ?? '')}" />
          </div>`;
        break;
      case 'gitlab': {
        const glConn = this.setupFields.gitlabConnectionType || 'api';
        const apiChecked = glConn === 'api' ? 'checked' : '';
        const mcpChecked = glConn === 'mcp' ? 'checked' : '';
        let glFields = `<div class="form-group">
            <label class="form-label">GitLab URL</label>
            <input class="form-input" data-field="gitlabUrl" type="url"
              placeholder="https://gitlab.com"
              value="${escapeHtml(this.setupFields.gitlabUrl ?? '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Connection Type</label>
            <div class="radio-group">
              <label><input type="radio" name="gitlabConnectionType" data-field="gitlabConnectionType" value="api" ${apiChecked} /> API Key</label>
              <label><input type="radio" name="gitlabConnectionType" data-field="gitlabConnectionType" value="mcp" ${mcpChecked} /> MCP Server</label>
            </div>
          </div>`;
        if (glConn === 'api') {
          glFields += `<div class="form-group">
            <label class="form-label">API Key</label>
            <input class="form-input" data-field="gitlabApiKey" type="password"
              placeholder="glpat-..."
              value="${escapeHtml(this.setupFields.gitlabApiKey ?? '')}" />
          </div>`;
        } else {
          glFields += `<div class="form-group">
            <label class="form-label">MCP Command</label>
            <input class="form-input" data-field="gitlabMcpCommand" type="text"
              placeholder="npx"
              value="${escapeHtml(this.setupFields.gitlabMcpCommand ?? '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">MCP Args</label>
            <input class="form-input" data-field="gitlabMcpArgs" type="text"
              placeholder="@gitlab/mcp-server"
              value="${escapeHtml(this.setupFields.gitlabMcpArgs ?? '')}" />
          </div>`;
        }
        fields = glFields;
        break;
      }
      case 'jira': {
        const jConn = this.setupFields.jiraConnectionType || 'stdio';
        const stdioChecked = jConn === 'stdio' ? 'checked' : '';
        const httpChecked = jConn === 'http' ? 'checked' : '';
        let jFields = `<div class="form-group">
            <label class="form-label">Connection Type</label>
            <div class="radio-group">
              <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="stdio" ${stdioChecked} /> Local MCP (stdio)</label>
              <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="http" ${httpChecked} /> Remote MCP (HTTP)</label>
            </div>
          </div>`;
        if (jConn === 'stdio') {
          jFields += `<div class="form-group">
            <label class="form-label">Command</label>
            <input class="form-input" data-field="jiraStdioCommand" type="text"
              placeholder="npx"
              value="${escapeHtml(this.setupFields.jiraStdioCommand ?? '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Args</label>
            <input class="form-input" data-field="jiraStdioArgs" type="text"
              placeholder="@anthropic/jira-mcp-server"
              value="${escapeHtml(this.setupFields.jiraStdioArgs ?? '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Working Directory</label>
            <input class="form-input" data-field="jiraCwd" type="text"
              placeholder="(optional)"
              value="${escapeHtml(this.setupFields.jiraCwd ?? '')}" />
          </div>`;
        } else {
          jFields += `<div class="form-group">
            <label class="form-label">MCP Server URL</label>
            <input class="form-input" data-field="jiraHttpUrl" type="url"
              placeholder="https://..."
              value="${escapeHtml(this.setupFields.jiraHttpUrl ?? '')}" />
          </div>`;
        }
        fields = jFields;
        break;
      }
      case 'demo':
        fields = '<div class="setup-info">Demo mode uses sample data — no setup needed!</div>';
        break;
      default:
        fields = '';
    }

    const modeLabel =
      this.setupMode === 'file'
        ? 'Plan File'
        : this.setupMode === 'github'
          ? 'GitHub'
          : this.setupMode === 'gitlab'
            ? 'GitLab'
            : this.setupMode === 'jira'
              ? 'Jira'
              : this.setupMode === 'demo'
                ? 'Demo'
                : 'Setup';

    return `<p class="setup-title">${escapeHtml(modeLabel)} Configuration</p>
      ${fields}
      <div class="btn-row">
        <button class="btn btn-secondary" data-action="back" type="button">← Back</button>
        <button class="btn btn-primary" data-action="save" type="button">Save &amp; Connect</button>
      </div>`;
  }

  private async saveSetupConfiguration(): Promise<void> {
    if (!this.setupMode) {
      return;
    }

    const config = vscode.workspace.getConfiguration('ticketManager');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await config.update('backendMode', this.setupMode, target);

    switch (this.setupMode) {
      case 'file':
        if (this.setupFields.planFilePath) {
          await config.update('planFilePath', this.setupFields.planFilePath, target);
        }
        break;
      case 'github':
        if (this.setupFields.githubUrl) {
          await config.update('githubUrl', this.setupFields.githubUrl, target);
        }
        if (this.setupFields.githubPat) {
          await config.update('githubPat', this.setupFields.githubPat, target);
        }
        if (this.setupFields.githubOwner) {
          await config.update('githubOwner', this.setupFields.githubOwner, target);
        }
        break;
      case 'gitlab':
        if (this.setupFields.gitlabUrl) {
          await config.update('gitlabUrl', this.setupFields.gitlabUrl, target);
        }
        {
          const glConnType = this.setupFields.gitlabConnectionType || 'api';
          await config.update('gitlabConnectionType', glConnType, target);
          if (glConnType === 'api' && this.setupFields.gitlabApiKey) {
            await config.update('gitlabApiKey', this.setupFields.gitlabApiKey, target);
          } else if (glConnType === 'mcp') {
            if (this.setupFields.gitlabMcpCommand) {
              await config.update('gitlabMcpCommand', this.setupFields.gitlabMcpCommand, target);
            }
            if (this.setupFields.gitlabMcpArgs) {
              await config.update(
                'gitlabMcpArgs',
                this.setupFields.gitlabMcpArgs.split(' ').filter(Boolean),
                target
              );
            }
          }
        }
        break;
      case 'jira': {
        const connType = this.setupFields.jiraConnectionType || 'stdio';
        await config.update('connectionType', connType, target);
        if (connType === 'stdio') {
          if (this.setupFields.jiraStdioCommand) {
            await config.update('stdioCommand', this.setupFields.jiraStdioCommand, target);
          }
          if (this.setupFields.jiraStdioArgs) {
            await config.update(
              'stdioArgs',
              this.setupFields.jiraStdioArgs.split(' ').filter(Boolean),
              target
            );
          }
          if (this.setupFields.jiraCwd) {
            await config.update('stdioCwd', this.setupFields.jiraCwd, target);
          }
        } else {
          if (this.setupFields.jiraHttpUrl) {
            await config.update('httpUrl', this.setupFields.jiraHttpUrl, target);
          }
        }
        break;
      }
      // demo needs no additional config
    }

    // Reset setup state
    this.setupStep = 0;
    this.setupMode = undefined;
    this.setupFields = {};

    // The config change listener in extension.ts will trigger a full refresh
    // which will re-render this view with the normal issues content
  }

  private renderIssuesSection(
    snapshot: ReturnType<IssuesTreeProvider['getSnapshot']>,
    filters: IssueFilters
  ): string {
    let content = '';
    if (snapshot.status === 'error') {
      content = `<div class="message error">${escapeHtml(snapshot.errorMessage ?? 'Unable to load issues.')}</div>`;
    } else if ((snapshot.status === 'idle' || snapshot.status === 'loading') && snapshot.issues.length === 0) {
      content = '<div class="message">Loading issues...</div>';
    } else if (snapshot.issues.length === 0) {
      content = filters.parentKey
        ? `<div class="message">No issues found for EPIC ${escapeHtml(filters.parentKey)}.</div>`
        : '<div class="message">No issues match the current filters.</div>';
    } else {
      const items = snapshot.issues
        .map(issue => {
          const classes = [
            'issue-row',
            this.selectedIssueKey === issue.key ? 'selected' : '',
            isDoneIssue(issue) ? 'done' : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `<div class="${classes}" data-issue-key="${escapeHtml(issue.key)}" title="${escapeHtml(`${issue.key}: ${issue.summary}`)}">
            <div class="row-main">
              <div class="row-left">
                <div class="item-key">${escapeHtml(issue.key)}</div>
                ${renderIssueTypeBadge(issue.issueType)}
                <div class="item-summary">${escapeHtml(issue.summary)}</div>
              </div>
              <div class="row-right">
                ${renderAssignmentBadge(issue)}
                ${renderStatusBadge(issue.status)}
                <div class="row-actions">
                  ${renderIconButton(`editIssue-${issue.key}`, 'Edit issue', 'edit').replace(
                    'id="editIssue-' + issue.key + '"',
                    `id="editIssue-${issue.key}" data-edit-issue-key="${escapeHtml(issue.key)}"`
                  )}
                  ${renderIconButton(`deleteIssue-${issue.key}`, 'Delete issue', 'delete').replace(
                    'id="deleteIssue-' + issue.key + '"',
                    `id="deleteIssue-${issue.key}" data-delete-issue-key="${escapeHtml(issue.key)}"`
                  )}
                </div>
              </div>
            </div>
          </div>`;
        })
        .join('');

      content = `<div class="item-list">${items}</div>`;
    }

    const loadMore = snapshot.hasMore
      ? '<button class="text-button load-more" id="loadMoreButton" type="button">Load more</button>'
      : '';

    return `<section class="section">
      ${content}
      ${loadMore}
    </section>`;
  }

  private renderSearchRow(filters: IssueFilters): string {
    return `<div class="search-row">
      <div class="search-field">
      <form class="search-form" id="searchForm">
        <input class="search-input" id="searchInput" type="search" placeholder="Search issues..." value="${escapeHtml(filters.searchText)}" />
      </form>
      <div class="filter-wrap">
        ${renderIconButton('filterButton', 'Filter issues', 'filter')}
        <div class="filter-menu" id="filterMenu">
          <p class="filter-title">Status</p>
          <div class="filter-options">
            ${this.statusOptions.length > 0
              ? this.statusOptions
                  .map(
                    status => `<label class="filter-option">
                      <input type="checkbox" value="${escapeHtml(status)}" ${filters.statuses.includes(status) ? 'checked' : ''} />
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
