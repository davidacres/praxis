import * as vscode from 'vscode';
import type { IssueTrackerService } from '@ticket-manager/core';
import type { AiSessionManager } from '@ticket-manager/core';
import { issueTypePillInlineStyle } from '@ticket-manager/core';
import { FilterStore } from '../state/filterStore';
import type { AiProvider, IssueFilters, IssueSummary } from '@ticket-manager/core';
import { IssuesTreeProvider } from './issuesTreeProvider';
import { renderIconButton } from './webviewToolbarIcons';

interface IssueAiAssignmentOption {
  provider: AiProvider;
  label: string;
}

interface IssuesSidebarCallbacks {
  onSelectIssue: (issueKey: string, openFullPanel?: boolean) => Promise<void>;
  onAssignToMe: (issueKey: string) => Promise<void>;
  onAssignToAi: (issueKey: string, provider: AiProvider) => Promise<void>;
  onEditIssue: (issueKey: string) => Promise<void>;
  onDeleteIssue: (issueKey: string) => Promise<void>;
  onSetSearchText?: (searchText: string) => Promise<void>;
  onSetStatuses?: (statuses: string[]) => Promise<void>;
  onLoadMore: () => Promise<void>;
}

type ResolveIssueTypeColors = () => Record<string, string> | undefined;

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
    case 'idea':
      return 'idea';
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

function renderIssueTypeBadge(
  issueType: string | undefined,
  overrideColors?: Record<string, string>
): string {
  const label = issueType?.trim() || 'Issue';
  const token = getIssueTypeToken(label);
  return `<span class="type-badge type-badge--${token}" style="${escapeHtml(issueTypePillInlineStyle(label, overrideColors))}">${escapeHtml(label)}</span>`;
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

export function buildIssueStatusMetadataFilters(filters: IssueFilters): IssueFilters {
  return {
    ...filters,
    statuses: [],
    issueTypes: [],
    searchText: '',
    assigneeMode: 'all'
  };
}

export class IssuesSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedIssueKey?: string;
  private statusOptions: string[] = [];
  private aiAssignOptions: IssueAiAssignmentOption[] = [];
  private supportingDataGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly filterStore: FilterStore,
    private readonly issuesProvider: IssuesTreeProvider,
    private readonly aiSessionManager: AiSessionManager,
    private readonly callbacks: IssuesSidebarCallbacks,
    private readonly resolveIssueTypeColors?: ResolveIssueTypeColors
  ) {
    this.disposables.push(
      this.filterStore.onDidChange(() => {
        void this.refresh();
      }),
      this.issuesProvider.onDidChangeTreeData(() => {
        void this.refresh();
      }),
      this.aiSessionManager.onDidChangeSession(() => {
        this.render();
      }),
      this.aiSessionManager.onDidChangeAgentSession(() => {
        this.render();
      })
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.disposables.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      })
    );
    webviewView.webview.onDidReceiveMessage(
      message => { void this.handleMessage(message); },
      undefined, this.disposables
    );
    void this.refresh();
  }

  public setSelectedIssueKey(issueKey: string | undefined): void {
    this.selectedIssueKey = issueKey;
    this.render();
  }

  public setAiAssignOptions(options: IssueAiAssignmentOption[]): void {
    this.aiAssignOptions = [...options];
    this.render();
  }

  public async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const generation = ++this.supportingDataGeneration;
    const filters = this.filterStore.getFilters();
    const snapshot = this.issuesProvider.getSnapshot();

    // Only the status filter needs supporting data now — issue types and
    // projects were for the removed create dialog.
    let statusOptions = unique([...filters.statuses, ...snapshot.issues.map(issue => issue.status)]);

    try {
      const metadata = await this.backendService.getFilterMetadata(
        buildIssueStatusMetadataFilters(filters)
      );
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
      case 'assignToMe': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        if (issueKey) {
          await this.callbacks.onAssignToMe(issueKey);
        }
        return;
      }
      case 'assignToAi': {
        const issueKey = typeof payload.issueKey === 'string' ? payload.issueKey : undefined;
        const provider = typeof payload.provider === 'string' ? payload.provider as AiProvider : undefined;
        if (issueKey && provider) {
          await this.callbacks.onAssignToAi(issueKey, provider);
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
      // Creation always happens in the Issue Detail draft pane, so the sidebar
      // only forwards the request and the issue type the button implies.
      case 'openIssueDraft': {
        const issueType = typeof payload.issueType === 'string' ? payload.issueType.trim() : '';
        await vscode.commands.executeCommand(
          'ticketManager.createIssue',
          issueType ? { issueType } : undefined
        );
        return;
      }
      case 'loadMore':
        await this.callbacks.onLoadMore();
        return;
      default:
        return;
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const filters = this.filterStore.getFilters();
    const snapshot = this.issuesProvider.getSnapshot();
    const nonce = createNonce();
    const issuesSection = this.renderIssuesSection(snapshot, filters, this.resolveIssueTypeColors?.());

    try {
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
        align-items: center;
        gap: 6px;
        width: 100%;
        flex-shrink: 0;
        box-sizing: border-box;
        padding: 8px 0 0;
        margin: 0;
      }
      .search-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
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
      .text-button--primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .text-button--primary:hover {
        background: var(--vscode-button-hoverBackground);
      }
      .issue-context-menu {
        position: fixed;
        z-index: 4;
        min-width: 180px;
        display: flex;
        flex-direction: column;
        padding: 6px 0;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 8px;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
      }
      .issue-context-menu[hidden] {
        display: none;
      }
      .issue-context-menu-item {
        border: none;
        background: transparent;
        color: var(--vscode-editor-foreground);
        text-align: left;
        padding: 8px 12px;
        cursor: pointer;
        font: inherit;
      }
      .issue-context-menu-item:hover {
        background: var(--vscode-list-hoverBackground);
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
        color: #e9d5ff;
        background: rgba(163, 113, 247, 0.16);
        border-color: rgba(163, 113, 247, 0.28);
      }
      .type-badge--feature {
        color: #99f6e4;
        background: rgba(63, 188, 205, 0.16);
        border-color: rgba(63, 188, 205, 0.28);
      }
      .type-badge--idea {
        color: #fde68a;
        background: rgba(245, 158, 11, 0.16);
        border-color: rgba(245, 158, 11, 0.28);
      }
      .type-badge--story {
        color: #bbf7d0;
        background: rgba(63, 185, 80, 0.16);
        border-color: rgba(63, 185, 80, 0.28);
      }
      .type-badge--task {
        color: #f5b5db;
        background: rgba(219, 97, 162, 0.16);
        border-color: rgba(219, 97, 162, 0.28);
      }
      .type-badge--bug {
        color: #fecaca;
        background: rgba(229, 83, 75, 0.16);
        border-color: rgba(229, 83, 75, 0.28);
      }
      .type-badge--issue {
        color: #a1a1aa;
        background: rgba(161, 161, 170, 0.1);
        border-color: rgba(161, 161, 170, 0.2);
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
        color: #a1a1aa;
        background: rgba(161, 161, 170, 0.1);
        border-color: rgba(161, 161, 170, 0.2);
      }
      .type-badge--assigned {
        color: #93c5fd;
        background: rgba(96, 165, 250, 0.1);
        border-color: rgba(96, 165, 250, 0.2);
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .type-badge--unassigned {
        color: #a1a1aa;
        background: rgba(161, 161, 170, 0.1);
        border-color: rgba(161, 161, 170, 0.2);
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .type-badge--ai {
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.16);
        border-color: rgba(251, 191, 36, 0.28);
        font-size: 11px;
        padding: 0 4px;
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
      ${this.renderSearchRow(filters)}
      ${issuesSection}
    </div>
    <div id="issueContextMenu" class="issue-context-menu" hidden role="menu" aria-label="Issue actions">
      <button type="button" class="issue-context-menu-item" role="menuitem" data-issue-menu-action="assignToMe">Assign to me</button>
      ${this.aiAssignOptions
        .map(
          option => `<button type="button" class="issue-context-menu-item" role="menuitem" data-issue-menu-action="assignToAi" data-issue-menu-provider="${escapeHtml(option.provider)}">Assign to ${escapeHtml(option.label)}</button>`
        )
        .join('')}
      <button type="button" class="issue-context-menu-item" role="menuitem" data-issue-menu-action="editIssue">Edit</button>
      <button type="button" class="issue-context-menu-item" role="menuitem" data-issue-menu-action="deleteIssue">Delete</button>
      <button type="button" class="issue-context-menu-item" role="menuitem" data-issue-menu-action="viewDetails">View Details</button>
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

      // Both buttons open the Issue Detail draft pane; the sidebar no longer
      // has a create form of its own.
      const createIssueButton = document.getElementById('createIssueButton');
      const createIdeaButton = document.getElementById('createIdeaButton');
      createIssueButton?.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'openIssueDraft' });
      });
      createIdeaButton?.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'openIssueDraft', issueType: 'Idea' });
      });

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
        row.addEventListener('dragstart', event => {
          const issueKey = row.getAttribute('data-issue-key');
          if (!issueKey || !event.dataTransfer) {
            return;
          }
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('application/x-ticket-manager-issue', issueKey);
          event.dataTransfer.setData('text/plain', issueKey);
        });
      }

      const issueContextMenu = document.getElementById('issueContextMenu');
      if (issueContextMenu) {
        issueContextMenu.addEventListener('click', event => event.stopPropagation());
        document.addEventListener('click', () => {
          issueContextMenu.hidden = true;
        });
        document.addEventListener('contextmenu', event => {
          const row = event.target.closest('.issue-row');
          if (!row) {
            return;
          }
          event.preventDefault();
          issueContextMenu.dataset.issueKey = row.getAttribute('data-issue-key') || '';
          issueContextMenu.style.left = event.clientX + 'px';
          issueContextMenu.style.top = event.clientY + 'px';
          issueContextMenu.hidden = false;
          requestAnimationFrame(() => {
            const bounds = issueContextMenu.getBoundingClientRect();
            let left = parseFloat(issueContextMenu.style.left) || 0;
            let top = parseFloat(issueContextMenu.style.top) || 0;
            if (left + bounds.width > window.innerWidth - 6) {
              left = window.innerWidth - bounds.width - 6;
            }
            if (top + bounds.height > window.innerHeight - 6) {
              top = window.innerHeight - bounds.height - 6;
            }
            issueContextMenu.style.left = Math.max(6, left) + 'px';
            issueContextMenu.style.top = Math.max(6, top) + 'px';
          });
        });
        for (const button of issueContextMenu.querySelectorAll('[data-issue-menu-action]')) {
          button.addEventListener('click', () => {
            const type = button.getAttribute('data-issue-menu-action');
            const issueKey = issueContextMenu.dataset.issueKey;
            const provider = button.getAttribute('data-issue-menu-provider');
            issueContextMenu.hidden = true;
            if (!issueKey || !type) {
              return;
            }
            if (type === 'viewDetails') {
              vscodeApi.postMessage({ type: 'selectIssue', issueKey, openFullPanel: true });
              return;
            }
            vscodeApi.postMessage({ type, issueKey, provider });
          });
        }
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
    } catch (error) {
      if (error instanceof Error && /disposed/i.test(error.message)) {
        this.view = undefined;
        return;
      }

      throw error;
    }
  }

  private renderIssuesSection(
    snapshot: ReturnType<IssuesTreeProvider['getSnapshot']>,
    filters: IssueFilters,
    issueTypeColors?: Record<string, string>
  ): string {
    let content = '';
    if (snapshot.requiresBoardSelection) {
      content = '<div class="message">Select a board to see its issues.</div>';
    } else if (snapshot.status === 'error') {
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
          const aiSession = this.aiSessionManager.getSession(issue.key);
          const aiBadge = aiSession
            ? `<span class="type-badge type-badge--ai" title="AI: ${escapeHtml(aiSession.provider)} (${escapeHtml(aiSession.status)})">🤖</span>`
            : '';
          return `<div class="${classes}" data-issue-key="${escapeHtml(issue.key)}" draggable="true" title="${escapeHtml(`${issue.key}: ${issue.summary}`)}">
            <div class="row-main">
              <div class="row-left">
                <div class="item-key">${escapeHtml(issue.key)}</div>
                ${renderIssueTypeBadge(issue.issueType, issueTypeColors)}
                ${aiBadge}
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
      <div class="search-actions">
        <button class="text-button text-button--primary" id="createIssueButton" type="button">New Issue</button>
        <button class="text-button" id="createIdeaButton" type="button">New Idea</button>
      </div>
    </div>`;
  }
}
