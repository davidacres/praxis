import * as vscode from 'vscode';
import { filterBoardIssues } from '@praxis/core';
import { findTransitionToTargetStatus } from '@praxis/core';
import { buildSwimLaneRows } from '@praxis/core';
import { issueTypeHex, issueTypePillInlineStyle } from '@praxis/core';
import { resolveStatusDotColor, statusLabelInlineStyle } from '@praxis/core';
import type { IssueTrackerService } from '@praxis/core';
import type { BoardColumnStore } from '@praxis/core';
import type { AiProvider, Board, BoardColumn, BoardDetails, IssueSummary } from '@praxis/core';
import { applyBoardColumnPreferences, getDefaultStatusColumnOrder } from './boardColumnLayout';
import { boardListModeIconSvg, resolveBackendModeBoardIconColor } from './boardModeIcon';
import { renderIconButton } from './webviewToolbarIcons';

interface BoardAiAssignmentOption {
  provider: AiProvider;
  label: string;
}

export interface BoardCardActionCallbacks {
  assignToMe: (issueKey: string) => Promise<void>;
  assignToAi: (issueKey: string, provider: AiProvider) => Promise<void>;
  editIssue: (issueKey: string) => Promise<void>;
  deleteIssue: (issueKey: string) => Promise<void>;
}

interface BoardPanelSnapshot {
  boardId?: string;
  boardName?: string;
  issueCount: number;
  columnNames: string[];
  loading: boolean;
  errorMessage?: string;
  selectedIssueKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function formatIssueMeta(issue: IssueSummary): string {
  const parts = [issue.assignee ?? 'Unassigned', issue.priority ?? 'Priority unknown'];
  return parts.join(' • ');
}

function isSafePriorityColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(value) || /^linear-gradient\([A-Za-z0-9#.,%\s-]+\)$/.test(value);
}

function resolvePriorityBarStyle(priority: string | undefined, priorityColors: Record<string, string>): string {
  const value = priority ? priorityColors[priority] : undefined;
  return value && isSafePriorityColor(value) ? `background: ${value};` : 'background: var(--vscode-descriptionForeground);';
}

interface BoardRenderPrefs {
  statusColors?: Record<string, string>;
  issueTypeColors?: Record<string, string>;
  priorityColors: Record<string, string>;
}

export class BoardPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeBoard?: Board;
  private activeBoardService?: IssueTrackerService;
  private readonly boardDetailsCache = new Map<string, BoardDetails>();
  private boardDetails?: BoardDetails;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;
  private selectedIssueKey?: string;
  private cardActions?: BoardCardActionCallbacks;
  private aiAssignOptions: BoardAiAssignmentOption[] = [];

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly onIssueSelected: (issue: IssueSummary) => Promise<void>,
    private readonly onAfterBoardTransition: (() => Promise<void>) | undefined,
    private readonly boardColumnStore: BoardColumnStore,
    private readonly resolveBoardService?: (board: Board) => Promise<IssueTrackerService>
  ) {}

  /** Wired from activation after issue edit/delete helpers exist. */
  public setCardActions(callbacks: BoardCardActionCallbacks | undefined): void {
    this.cardActions = callbacks;
  }

  public setAiAssignOptions(options: BoardAiAssignmentOption[]): void {
    this.aiAssignOptions = [...options];
    this.render();
  }

  public getActiveBoard(): Board | undefined {
    return this.activeBoard;
  }

  public refreshColumnLayout(): void {
    this.render();
  }

  public async openBoard(board: Board, options?: { forceRecreatePanel?: boolean }): Promise<void> {
    this.activeBoard = board;
    this.boardDetails = this.boardDetailsCache.get(board.id);
    this.loading = true;
    this.errorMessage = undefined;
    this.activeBoardService = undefined;
    // After a classic <-> work mode transition the existing webview panel can be
    // left in a detached/blank state (VS Code Insiders). Recreating it instead of
    // reusing it guarantees a fresh, rendered panel. See CLAUDE.md webview rules.
    if (options?.forceRecreatePanel) {
      this.disposePanel();
    }
    this.ensurePanel();
    // Reveal into a concrete editor column rather than ViewColumn.Active. After a
    // mode switch the activity-bar/sidebar may be focused, so ViewColumn.Active no
    // longer points at an editor group and the tab would not surface.
    this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One, false);
    this.render();
    await this.refresh();
  }

  /** Dispose the current webview panel (if any) without clearing board state. */
  private disposePanel(): void {
    if (this.panel) {
      const panel = this.panel;
      this.panel = undefined;
      panel.dispose();
    }
  }

  public async refresh(): Promise<void> {
    const activeBoard = this.activeBoard;
    if (!activeBoard) {
      return;
    }

    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;
    this.render();

    try {
      const boardService = await this.getActiveBoardService(activeBoard);
      const boardDetails = await boardService.getBoardDetails(activeBoard);
      if (generation !== this.requestGeneration) {
        return;
      }

      await this.boardColumnStore.normalizeLegacyPreferences(
        activeBoard.id,
        getDefaultStatusColumnOrder(boardDetails)
      );
      if (generation !== this.requestGeneration) {
        return;
      }

      this.boardDetailsCache.set(activeBoard.id, boardDetails);
      this.boardDetails = boardDetails;
      this.loading = false;
      this.errorMessage = undefined;

      if (
        this.selectedIssueKey &&
        !boardDetails.issues.some((issue: IssueSummary) => issue.key === this.selectedIssueKey)
      ) {
        this.selectedIssueKey = undefined;
      }
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.boardDetails = this.boardDetailsCache.get(activeBoard.id);
    } finally {
      if (generation === this.requestGeneration) {
        this.render();
      }
    }
  }

  public setSelectedIssueKey(issueKey: string | undefined): void {
    this.selectedIssueKey = issueKey;
    this.render();
  }

  public async selectIssue(issueKey: string): Promise<void> {
    await this.handleIssueSelection(issueKey);
  }

  public clear(): void {
    this.activeBoard = undefined;
    this.activeBoardService = undefined;
    this.boardDetails = undefined;
    this.loading = false;
    this.errorMessage = undefined;
    this.selectedIssueKey = undefined;
    this.requestGeneration += 1;
    this.render();
  }

  public getSnapshot(): BoardPanelSnapshot {
    const display = this.getDisplayBoardDetails();
    return {
      boardId: this.activeBoard?.id,
      boardName: this.activeBoard?.name,
      issueCount: this.boardDetails?.issues.length ?? 0,
      columnNames: display?.columns.map(column => column.name) ?? [],
      loading: this.loading,
      errorMessage: this.errorMessage,
      selectedIssueKey: this.selectedIssueKey
    };
  }

  public getCurrentDisplayDetails(): BoardDetails | undefined {
    return this.getDisplayBoardDetails() ?? this.boardDetails;
  }

  public async getActiveBoardDisplayDetails(): Promise<BoardDetails | undefined> {
    if (!this.activeBoard) {
      return undefined;
    }

    if (!this.boardDetails && !this.loading) {
      await this.refresh();
    }

    const display = this.getDisplayBoardDetails() ?? this.boardDetails;
    if (!display) {
      if (this.errorMessage) {
        throw new Error(this.errorMessage);
      }
      return undefined;
    }

    return display;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.boardPanel',
      this.activeBoard ? `Board: ${this.activeBoard.name}` : 'Board',
      // Use a concrete editor column so the panel always lands in the editor
      // group, even when the sidebar/activity-bar is focused (e.g. right after a
      // classic <-> work mode switch).
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      []
    );

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );

    this.render();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (type === 'refresh') {
      await this.refresh();
      return;
    }

    if (type === 'createIssue') {
      await vscode.commands.executeCommand('ticketManager.createIssue', this.activeBoard);
      return;
    }

if (type === 'openColumnConfig') {
      await vscode.commands.executeCommand('ticketManager.configureBoardColumns');
      return;
    }

    if (type === 'openFullDetails') {
      const issueKey = asString(message.issueKey);
      if (!issueKey) {
        return;
      }

      await vscode.commands.executeCommand('ticketManager.openIssueFullDetails', issueKey);
      return;
    }

    if (type === 'toggleViewMode') {
      if (!this.activeBoard) {
        return;
      }
      const current = this.boardColumnStore.getPreferences(this.activeBoard.id).viewMode ?? 'board';
      await this.boardColumnStore.setViewMode(this.activeBoard.id, current === 'list' ? 'board' : 'list');
      this.render();
      return;
    }

    if (type === 'reorderGroups') {
      if (!this.activeBoard || !Array.isArray(message.orderedStatuses)) {
        return;
      }
      const orderedStatuses = message.orderedStatuses.filter((status): status is string => typeof status === 'string');
      await this.boardColumnStore.setGroupOrder(this.activeBoard.id, orderedStatuses);
      this.render();
      return;
    }

    if (type === 'boardCardAction') {
      const action = asString(message.action);
      const issueKey = asString(message.issueKey);
      if (!issueKey || !action) {
        return;
      }
      const provider = asString(message.provider) as AiProvider | undefined;
      if (action === 'viewDetails') {
        await vscode.commands.executeCommand('ticketManager.openIssueFullDetails', issueKey);
        return;
      }
      const actions = this.cardActions;
      if (!actions) {
        return;
      }
      try {
        if (action === 'assignToMe') {
          await actions.assignToMe(issueKey);
        } else if (action === 'assignToAi' && provider) {
          await actions.assignToAi(issueKey, provider);
        } else if (action === 'edit') {
          await actions.editIssue(issueKey);
        } else if (action === 'delete') {
          await actions.deleteIssue(issueKey);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(text);
      }
      return;
    }

    if (type === 'reorderIssue') {
      const issueKey = asString(message.issueKey);
      const status = asString(message.status);
      const beforeKey = asString(message.beforeKey) ?? undefined;
      if (!issueKey || !status) {
        return;
      }

      await this.handleReorderIssue(issueKey, status, beforeKey);
      return;
    }

    if (type === 'moveIssue') {
      const issueKey = asString(message.issueKey);
      const targetStatus = asString(message.targetStatus);
      if (!issueKey || !targetStatus) {
        return;
      }

      await this.handleMoveIssue(issueKey, targetStatus);
      return;
    }

    if (type !== 'selectIssue') {
      return;
    }

    const issueKey = asString(message.issueKey);
    if (!issueKey) {
      return;
    }

    await this.handleIssueSelection(issueKey);
  }

  private async handleIssueSelection(issueKey: string): Promise<void> {
    if (!this.boardDetails) {
      return;
    }

    const selectedIssue = this.boardDetails.issues.find(issue => issue.key === issueKey);
    if (!selectedIssue) {
      return;
    }

    this.selectedIssueKey = selectedIssue.key;
    await this.onIssueSelected(selectedIssue);
    this.render();
  }

  private async handleMoveIssue(issueKey: string, targetStatus: string): Promise<void> {
    if (!this.boardDetails) {
      return;
    }

    const issue = this.boardDetails.issues.find(candidate => candidate.key === issueKey);
    if (!issue) {
      return;
    }

    const current = issue.status.trim().toLowerCase();
    const target = targetStatus.trim().toLowerCase();
    if (current === target) {
      return;
    }

    if (targetStatus === 'Other statuses') {
      void vscode.window.showInformationMessage(
        'Use a workflow status column as the drop target. Issues here are only shown because their status is hidden from the board.'
      );
      return;
    }

    try {
      const boardService = await this.getActiveBoardService();
      const transitions = await boardService.getTransitions(issueKey);
      const transition = findTransitionToTargetStatus(transitions, targetStatus);
      if (!transition) {
        const hint =
          transitions.length > 0
            ? ` Available transitions: ${transitions
                .map((t: (typeof transitions)[number]) => (t.toStatus ? `${t.name} → ${t.toStatus}` : t.name))
                .join('; ')}`
            : '';
        void vscode.window.showWarningMessage(
          `No workflow step moves ${issueKey} from "${issue.status}" to "${targetStatus}".${hint}`
        );
        return;
      }

      await boardService.transitionIssue(issueKey, transition.id);
      await this.refresh();
      await this.onAfterBoardTransition?.();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not move ${issueKey}: ${text}`);
    }
  }

  private async handleReorderIssue(
    issueKey: string,
    status: string,
    beforeKey?: string
  ): Promise<void> {
    if (!this.activeBoard || !this.boardDetails) {
      return;
    }

    const display = this.getDisplayBoardDetails();
    if (!display) {
      return;
    }

    const column = display.columns.find(col => col.name === status);
    if (!column) {
      return;
    }

    const currentKeys = column.issues.map(issue => issue.key);
    const filtered = currentKeys.filter(key => key !== issueKey);

    if (beforeKey) {
      const insertIndex = filtered.indexOf(beforeKey);
      if (insertIndex >= 0) {
        filtered.splice(insertIndex, 0, issueKey);
      } else {
        filtered.push(issueKey);
      }
    } else {
      filtered.push(issueKey);
    }

    await this.boardColumnStore.setIssueOrder(this.activeBoard.id, status, filtered);
    this.render();
  }

  private getDisplayBoardDetails(): BoardDetails | undefined {
    if (!this.boardDetails || !this.activeBoard) {
      return this.boardDetails;
    }

    const prefs = this.boardColumnStore.getPreferences(this.activeBoard.id);
    const filtered: BoardDetails = {
      ...this.boardDetails,
      issues: filterBoardIssues(this.boardDetails.issues, prefs)
    };
    const effectivePrefs = prefs.viewMode === 'list'
      ? { ...prefs, orderedStatuses: [] as string[] }
      : prefs;
    return applyBoardColumnPreferences(filtered, effectivePrefs);
  }

  private async getActiveBoardService(board?: Board): Promise<IssueTrackerService> {
    const targetBoard = board ?? this.activeBoard;
    if (targetBoard?.connectionId && this.resolveBoardService) {
      const service = await this.resolveBoardService(targetBoard);
      this.activeBoardService = service;
      return service;
    }

    this.activeBoardService = this.backendService;
    return this.backendService;
  }

  private renderBoardColumnsHtml(columns: BoardColumn[], prefs: BoardRenderPrefs): string {
    return columns
      .map(
        column => `
                        <section class="column" data-column-status="${escapeHtml(column.name)}">
                          <header class="column-header">
                            <div class="column-title">
                              <span class="column-name" style="${escapeHtml(
                                statusLabelInlineStyle(column.name, prefs.statusColors)
                              )}">${escapeHtml(column.name)}</span>
                            </div>
                            <span class="column-count">${column.issues.length}</span>
                          </header>
                          <div class="column-body" data-drop-target="true">
                            ${column.issues
                              .map(
                                issue => `
                                  <div class="issue-card${this.selectedIssueKey === issue.key ? ' selected' : ''}" draggable="true" data-issue-key="${escapeHtml(issue.key)}" style="border-top: 2px solid ${escapeHtml(issueTypeHex(issue.issueType, prefs.issueTypeColors))}59;">
                                    <div class="priority-bar" style="${escapeHtml(resolvePriorityBarStyle(issue.priority, prefs.priorityColors))}"></div>
                                    <div class="issue-card-content">
                                      <div class="issue-card-top">
                                        <button type="button" class="issue-key-btn" data-issue-key="${escapeHtml(issue.key)}">${escapeHtml(issue.key)}</button>
                                        <span class="issue-type-pill" style="${escapeHtml(
                                          issueTypePillInlineStyle(issue.issueType, prefs.issueTypeColors)
                                        )}">${escapeHtml(issue.issueType)}</span>
                                      </div>
                                      <span class="issue-summary">${escapeHtml(issue.summary)}</span>
                                      <div class="issue-card-footer">
                                        <span class="issue-status-dot" style="background: ${escapeHtml(
                                          resolveStatusDotColor(issue.status, prefs.statusColors)
                                        )};" title="${escapeHtml(issue.status)}" aria-hidden="true"></span>
                                        <span class="issue-meta">${escapeHtml(formatIssueMeta(issue))}</span>
                                      </div>
                                    </div>
                                  </div>
                                `
                              )
                              .join('')}
                          </div>
                        </section>
                      `
      )
      .join('');
  }

  private renderListViewHtml(columns: BoardColumn[], prefs: BoardRenderPrefs): string {
    return columns
      .map(
        column => `
          <section class="list-group" draggable="true" data-group-status="${escapeHtml(column.name)}">
            <header class="list-group-header">
              <span class="drag-handle" aria-hidden="true">⠿</span>
              <span class="column-name" style="${escapeHtml(
                statusLabelInlineStyle(column.name, prefs.statusColors)
              )}">${escapeHtml(column.name)}</span>
              <span class="column-count">${column.issues.length}</span>
            </header>
            <div class="list-group-body">
              ${column.issues.length === 0
                ? '<div class="list-empty">No issues</div>'
                : column.issues
                    .map(
                      issue => `
                        <div class="list-item${this.selectedIssueKey === issue.key ? ' selected' : ''}" data-issue-key="${escapeHtml(issue.key)}" style="border-top: 2px solid ${escapeHtml(issueTypeHex(issue.issueType, prefs.issueTypeColors))}59;">
                          <div class="priority-bar" style="${escapeHtml(resolvePriorityBarStyle(issue.priority, prefs.priorityColors))}"></div>
                          <div class="list-item-inner">
                            <button type="button" class="issue-key-btn" data-issue-key="${escapeHtml(issue.key)}">${escapeHtml(issue.key)}</button>
                            <span class="issue-type-pill" style="${escapeHtml(
                              issueTypePillInlineStyle(issue.issueType, prefs.issueTypeColors)
                            )}">${escapeHtml(issue.issueType)}</span>
                            <span class="list-item-summary">${escapeHtml(issue.summary)}</span>
                            <span class="issue-status-dot" style="background: ${escapeHtml(
                              resolveStatusDotColor(issue.status, prefs.statusColors)
                            )};" title="${escapeHtml(issue.status)}" aria-hidden="true"></span>
                            <span class="issue-meta">${escapeHtml(formatIssueMeta(issue))}</span>
                          </div>
                        </div>
                      `
                    )
                    .join('')}
            </div>
          </section>
        `
      )
      .join('');
  }

  private render(): void {
    if (!this.panel) {
      return;
    }

    this.panel.title = this.activeBoard ? `Board: ${this.activeBoard.name}` : 'Board';
    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const board = this.activeBoard;
    const headerTitle = board ? escapeHtml(board.name) : 'No board selected';
    const headerTitleHtml = board
      ? `<span class="header-title-with-icon"><span class="board-header-icon" style="color: ${escapeHtml(
          resolveBackendModeBoardIconColor(this.activeBoardService?.mode ?? this.backendService.mode)
        )}">${boardListModeIconSvg(this.activeBoardService?.mode ?? this.backendService.mode)}</span><span>${escapeHtml(board.name)}</span></span>`
      : headerTitle;
    const headerMeta = board
      ? [
          board.type.toUpperCase(),
          board.projectKey
            ? escapeHtml(board.projectName ? `${board.projectKey} • ${board.projectName}` : board.projectKey)
            : undefined,
          board.locationName ? escapeHtml(board.locationName) : undefined
        ]
          .filter((value): value is string => Boolean(value))
          .join(' • ')
      : 'Select a board from the sidebar.';

    const prefs = board ? this.boardColumnStore.getPreferences(board.id) : undefined;
    const viewMode = prefs?.viewMode ?? 'board';
    const display = this.getDisplayBoardDetails() ?? this.boardDetails;
    const hasDisplay = Boolean(display);

    let statusNotice = '';
    if (board && hasDisplay) {
      if (this.loading) {
        statusNotice = `
          <div class="status-notice">
            <strong>Refreshing board...</strong>
            <span>Showing the last loaded view while new data is fetched.</span>
          </div>
        `;
      } else if (this.errorMessage) {
        statusNotice = `
          <div class="status-notice error">
            <strong>Refresh failed.</strong>
            <span>${escapeHtml(this.errorMessage)}</span>
          </div>
        `;
      }
    }

    let body = `
      <section class="empty-state">
        <h2>No board selected</h2>
        <p>Select a board from the Boards view.</p>
      </section>
    `;

    if (board) {
      if (this.loading && !hasDisplay) {
        body = `
          <section class="empty-state loading-state">
            <div class="board-loading-spinner" role="status" aria-label="Loading board">
              <span class="board-loading-ring board-loading-ring--1"></span>
              <span class="board-loading-ring board-loading-ring--2"></span>
              <span class="board-loading-ring board-loading-ring--3"></span>
            </div>
            <h2>Loading ${escapeHtml(board.name)}...</h2>
            <p>Fetching issues for the selected board.</p>
          </section>
        `;
      } else if (this.errorMessage && !hasDisplay) {
        body = `
          <section class="empty-state error">
            <h2>Unable to load board</h2>
            <p>${escapeHtml(this.errorMessage)}</p>
          </section>
        `;
      } else if (display) {
        const columnPrefs = this.boardColumnStore.getPreferences(board.id);
        const swim = columnPrefs.swimLaneGroupBy;
        const priorityColors = vscode.workspace.getConfiguration('ticketManager').get<Record<string, string>>('priorityColors', {});
        const renderPrefs: BoardRenderPrefs = {
          statusColors: columnPrefs.statusColors,
          issueTypeColors: columnPrefs.issueTypeColors,
          priorityColors
        };
        if (display.columns.length === 0) {
          body = `
                <section class="empty-state">
                  <h2>No issues on this board</h2>
                  <p>The selected board does not currently contain any issues.</p>
                </section>
              `;
        } else if (viewMode === 'list') {
          const groupOrder = prefs?.listGroupOrder;
          const orderedColumns = groupOrder?.length
            ? [...display.columns].sort((a, b) => {
                const ai = groupOrder.indexOf(a.name);
                const bi = groupOrder.indexOf(b.name);
                return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
              })
            : display.columns;
          body = `<div class="list-view">${this.renderListViewHtml(orderedColumns, renderPrefs)}</div>`;
        } else if (swim === 'assignee' || swim === 'epic') {
          const lanes = buildSwimLaneRows(display, swim);
          body = `
                <div class="swim-board">
                  ${lanes
                    .map(
                      lane => `
                    <section class="swim-lane">
                      <button type="button" class="swim-lane-header" data-swim-toggle aria-expanded="true">
                        <span class="swim-lane-chevron" aria-hidden="true">▼</span>
                        <span class="swim-lane-title-text">${escapeHtml(lane.title)}</span>
                        </button>
                        <div class="swim-lane-body">
                          <div class="board-grid swim-lane-grid">
                          ${this.renderBoardColumnsHtml(lane.columns, renderPrefs)}
                        </div>
                      </div>
                    </section>
                  `
                    )
                    .join('')}
                </div>
              `;
        } else {
          body = `
                <section class="board-grid">
                  ${this.renderBoardColumnsHtml(display.columns, renderPrefs)}
                </section>
              `;
        }
      }
    }

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${headerTitle}</title>
    <style>
      :root {
        color-scheme: light dark;
        --vscode-focusBorder: #2563eb;
      }

      html, body {
        height: 100%;
      }

      body {
        margin: 0;
        padding: 0;
        display: flex;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }

      .page {
        box-sizing: border-box;
        display: flex;
        flex: 1;
        width: 100%;
        min-height: 100vh;
        padding: 8px;
      }

      .panel-shell {
        box-sizing: border-box;
        display: flex;
        flex: 1;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-sideBar-background);
        overflow: hidden;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        padding: 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
        flex-shrink: 0;
      }

      .header-main {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .header h1 {
        margin: 0;
        font-size: 18px;
      }

      .header-title-with-icon {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .board-header-icon {
        display: inline-flex;
        flex-shrink: 0;
        width: 22px;
        height: 22px;
      }

      .board-header-icon svg {
        width: 100%;
        height: 100%;
      }

      .header p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
      }

      .header-actions {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 6px;
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

      .content {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 12px;
        min-height: 0;
        padding: 16px;
        overflow: auto;
      }

      .status-notice {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 10px 12px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .status-notice strong {
        color: var(--vscode-editor-foreground);
      }

      .status-notice.error {
        border-color: var(--vscode-errorForeground);
        color: var(--vscode-errorForeground);
      }

      .status-notice.error strong {
        color: var(--vscode-errorForeground);
      }

      .swim-board {
        display: flex;
        flex-direction: column;
        gap: 18px;
        flex: 1;
        min-height: 100%;
        min-width: 0;
        overflow: auto;
        padding-bottom: 8px;
      }

      .swim-lane {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-sideBar-background);
        overflow: hidden;
        flex-shrink: 0;
      }

      .swim-lane-header {
        box-sizing: border-box;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px 14px;
        border: none;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        color: var(--vscode-editor-foreground);
        cursor: pointer;
        text-align: left;
      }

      .swim-lane-header:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .swim-lane-chevron {
        display: inline-flex;
        width: 14px;
        flex-shrink: 0;
        justify-content: center;
        transition: transform 0.15s ease;
        font-size: 10px;
        line-height: 1;
      }

      .swim-lane.collapsed .swim-lane-chevron {
        transform: rotate(-90deg);
      }

      .swim-lane.collapsed .swim-lane-body {
        display: none;
      }

      .swim-lane-title-text {
        min-width: 0;
      }

      .swim-lane-grid {
        padding: 8px 4px;
        min-height: 120px;
      }

      .board-grid {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(260px, 1fr);
        gap: 16px;
        align-items: stretch;
        flex: 1;
        min-height: 100%;
        overflow-x: auto;
        padding-bottom: 8px;
      }

      .column {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        border: none;
        border-radius: 6px;
        background: color-mix(in srgb, var(--vscode-sideBar-background) 60%, transparent);
      }

      .column-header {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        gap: 8px;
        padding: 12px 12px 10px;
        border-bottom: none;
      }

      .column-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      /* Jira-style flat column label: no pill, no background, no border. */
      .column-name {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .column-count {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        font-weight: 400;
        flex-shrink: 0;
      }

      .column-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 6px;
        min-height: 0;
        padding: 6px 4px 8px;
        overflow-y: auto;
      }

      .issue-card {
        display: flex;
        flex-direction: row;
        gap: 0;
        width: 100%;
        flex-shrink: 0;
        text-align: left;
        border: 1px solid var(--vscode-focusBorder);
        border-radius: 4px;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        color: inherit;
        cursor: grab;
        box-sizing: border-box;
        position: relative;
        overflow: hidden;
      }

      .priority-bar {
        width: 4px;
        min-width: 4px;
        flex-shrink: 0;
        border-radius: 4px 0 0 4px;
        align-self: stretch;
      }

      .issue-card-content {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
        padding: 8px 10px;
      }

      .issue-card-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
      }

      .issue-type-pill {
        flex-shrink: 0;
        max-width: 55%;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.3;
        border: 1px solid transparent;
        box-sizing: border-box;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .issue-card-footer {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .issue-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        flex-shrink: 0;
      }

      .board-card-menu {
        position: fixed;
        z-index: 10000;
        min-width: 180px;
        padding: 4px 0;
        margin: 0;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: var(--vscode-menu-background);
        color: var(--vscode-menu-foreground);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      }

      .board-card-menu-item {
        display: block;
        width: 100%;
        margin: 0;
        padding: 6px 14px;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }

      .board-card-menu-item:hover {
        background: var(--vscode-menu-selectionBackground);
        color: var(--vscode-menu-selectionForeground);
      }

      .issue-card:active {
        cursor: grabbing;
      }

      .issue-card.dragging {
        opacity: 0.55;
      }

      .column-body.drag-over {
        outline: 2px dashed var(--vscode-focusBorder);
        outline-offset: -2px;
        border-radius: 6px;
        background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
      }

      .drop-indicator {
        height: 2px;
        background: var(--vscode-focusBorder);
        border-radius: 1px;
        flex-shrink: 0;
        pointer-events: none;
      }

      .issue-key-btn {
        align-self: flex-start;
        margin: 0;
        padding: 0;
        border: none;
        background: none;
        font: inherit;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .issue-key-btn:hover {
        color: var(--vscode-textLink-activeForeground);
      }

      .issue-card:hover {
        border-color: var(--vscode-focusBorder);
      }

      .issue-card.selected {
        border-color: var(--vscode-focusBorder);
        box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
      }

      .issue-summary {
        line-height: 1.35;
      }

      .issue-meta {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .empty-state {
        padding: 24px;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        color: var(--vscode-descriptionForeground);
      }

      .empty-state h2 {
        margin-top: 0;
        color: var(--vscode-editor-foreground);
      }

      .empty-state.error {
        border-color: var(--vscode-errorForeground);
      }

      .empty-state.loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        text-align: center;
      }

      .board-loading-spinner {
        position: relative;
        width: 56px;
        height: 56px;
      }

      .board-loading-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 3px solid transparent;
        animation: board-loading-spin 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
      }

      .board-loading-ring--1 {
        border-top-color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground, #6366f1));
        animation-duration: 1.4s;
      }

      .board-loading-ring--2 {
        inset: 9px;
        border-top-color: color-mix(in srgb, var(--vscode-textLink-foreground, #6366f1) 70%, transparent);
        animation-duration: 1.05s;
        animation-direction: reverse;
      }

      .board-loading-ring--3 {
        inset: 18px;
        border-top-color: color-mix(in srgb, var(--vscode-textLink-foreground, #6366f1) 45%, transparent);
        animation-duration: 0.8s;
      }

      @keyframes board-loading-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      @media (prefers-reduced-motion: reduce) {
        .board-loading-ring {
          animation-duration: 3s;
        }
      }

      .list-view {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 4px;
        min-height: 0;
        overflow-y: auto;
      }

      .list-group {
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
        border-radius: 6px;
        overflow: hidden;
        cursor: default;
      }

      .list-group.drag-over-group {
        border-color: var(--vscode-focusBorder);
        box-shadow: 0 0 0 1px var(--vscode-focusBorder);
      }

      .list-group.dragging-group {
        opacity: 0.4;
      }

      .list-group-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        font-weight: 600;
        font-size: 12px;
        user-select: none;
      }

      .drag-handle {
        cursor: grab;
        opacity: 0.5;
        font-size: 14px;
        line-height: 1;
      }

      .drag-handle:hover {
        opacity: 1;
      }

      .list-group-body {
        display: flex;
        flex-direction: column;
      }

      .list-item {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: 0;
        border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12));
        font-size: 12px;
        cursor: pointer;
        overflow: hidden;
      }

      .list-item .priority-bar {
        border-radius: 0;
      }

      .list-item-inner {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        padding: 5px 10px 5px 30px;
      }

      .list-item:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .list-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .list-item-summary {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .list-empty {
        padding: 8px 10px 8px 30px;
        font-size: 12px;
        opacity: 0.6;
        font-style: italic;
      }

      .group-drop-indicator {
        height: 3px;
        margin: 0 4px;
        border-radius: 2px;
        background: var(--vscode-focusBorder);
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="panel-shell">
        <header class="header">
          <div class="header-main">
            <h1>${headerTitleHtml}</h1>
            <p>${headerMeta}</p>
          </div>
          <div class="header-actions">
            ${renderIconButton('newIssueButton', 'New issue', 'new-issue')}
            ${renderIconButton('createMenuButton', 'New issue', 'add')}
            ${board ? renderIconButton('viewModeButton', viewMode === 'list' ? 'Switch to board view' : 'Switch to list view', viewMode === 'list' ? 'board-view' : 'list') : ''}
            ${renderIconButton('columnsButton', 'Configure board settings', 'columns')}
            ${renderIconButton('refreshButton', 'Refresh', 'refresh')}
          </div>
        </header>
        <main class="content">${statusNotice}${body}</main>
      </div>
    </div>
    <div id="boardCardMenu" class="board-card-menu" hidden role="menu" aria-label="Issue actions">
      <button type="button" class="board-card-menu-item" role="menuitem" data-board-menu-action="assignToMe">Assign to me</button>
      ${this.aiAssignOptions
        .map(
          option => `<button type="button" class="board-card-menu-item" role="menuitem" data-board-menu-action="assignToAi" data-board-menu-provider="${escapeHtml(option.provider)}">Assign to ${escapeHtml(option.label)}</button>`
        )
        .join('')}
      <button type="button" class="board-card-menu-item" role="menuitem" data-board-menu-action="edit">Edit</button>
      <button type="button" class="board-card-menu-item" role="menuitem" data-board-menu-action="delete">Delete</button>
      <button type="button" class="board-card-menu-item" role="menuitem" data-board-menu-action="viewDetails">View Details</button>
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      const newIssueButton = document.getElementById('newIssueButton');
      if (newIssueButton) {
        newIssueButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'createIssue' });
        });
      }

      const createMenuButton = document.getElementById('createMenuButton');
      if (createMenuButton) {
        createMenuButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'createIssue' });
        });
      }

      const columnsButton = document.getElementById('columnsButton');
      if (columnsButton) {
        columnsButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'openColumnConfig' });
        });
      }

      const refreshButton = document.getElementById('refreshButton');
      if (refreshButton) {
        refreshButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'refresh' });
        });
      }

      const viewModeButton = document.getElementById('viewModeButton');
      if (viewModeButton) {
        viewModeButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'toggleViewMode' });
        });
      }

      for (const header of document.querySelectorAll('[data-swim-toggle]')) {
        header.addEventListener('click', () => {
          const lane = header.closest('.swim-lane');
          if (!lane) {
            return;
          }
          const collapsed = lane.classList.toggle('collapsed');
          header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });
      }

      const boardCardMenu = document.getElementById('boardCardMenu');
      if (boardCardMenu) {
        boardCardMenu.addEventListener('click', e => e.stopPropagation());
        document.addEventListener('click', () => {
          boardCardMenu.hidden = true;
        });
        document.addEventListener('contextmenu', e => {
          const card = e.target.closest('.issue-card');
          if (!card) {
            return;
          }
          e.preventDefault();
          const key = card.getAttribute('data-issue-key');
          boardCardMenu.dataset.issueKey = key || '';
          boardCardMenu.style.position = 'fixed';
          boardCardMenu.hidden = false;
          boardCardMenu.style.left = e.clientX + 'px';
          boardCardMenu.style.top = e.clientY + 'px';
          requestAnimationFrame(() => {
            const r = boardCardMenu.getBoundingClientRect();
            let left = parseFloat(boardCardMenu.style.left) || 0;
            let top = parseFloat(boardCardMenu.style.top) || 0;
            if (left + r.width > window.innerWidth - 6) {
              left = window.innerWidth - r.width - 6;
            }
            if (top + r.height > window.innerHeight - 6) {
              top = window.innerHeight - r.height - 6;
            }
            boardCardMenu.style.left = Math.max(6, left) + 'px';
            boardCardMenu.style.top = Math.max(6, top) + 'px';
          });
        });
        for (const btn of boardCardMenu.querySelectorAll('[data-board-menu-action]')) {
          btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-board-menu-action');
            const issueKey = boardCardMenu.dataset.issueKey;
            const provider = btn.getAttribute('data-board-menu-provider');
            boardCardMenu.hidden = true;
            if (issueKey && action) {
              vscodeApi.postMessage({ type: 'boardCardAction', action, issueKey, provider });
            }
          });
        }
      }

      for (const keyBtn of document.querySelectorAll('.issue-key-btn')) {
        keyBtn.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({
            type: 'openFullDetails',
            issueKey: keyBtn.getAttribute('data-issue-key')
          });
        });
      }

      let ignoreNextCardClick = false;

      let dropIndicator = null;
      function getDropIndicator() {
        if (!dropIndicator) {
          dropIndicator = document.createElement('div');
          dropIndicator.className = 'drop-indicator';
        }
        return dropIndicator;
      }
      function removeDropIndicator() {
        if (dropIndicator && dropIndicator.parentNode) {
          dropIndicator.parentNode.removeChild(dropIndicator);
        }
      }
      function getInsertBeforeCard(columnBody, y) {
        const cards = [...columnBody.querySelectorAll('.issue-card:not(.dragging)')];
        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          if (y < rect.top + rect.height / 2) {
            return card;
          }
        }
        return null;
      }

      for (const issueCard of document.querySelectorAll('.issue-card')) {
        issueCard.addEventListener('dragstart', event => {
          const key = issueCard.getAttribute('data-issue-key');
          if (key && event.dataTransfer) {
            event.dataTransfer.setData('text/plain', key);
            event.dataTransfer.effectAllowed = 'move';
          }
          issueCard.classList.add('dragging');
        });
        issueCard.addEventListener('dragend', () => {
          issueCard.classList.remove('dragging');
          removeDropIndicator();
          for (const zone of document.querySelectorAll('.column-body')) {
            zone.classList.remove('drag-over');
          }
          ignoreNextCardClick = true;
          setTimeout(() => {
            ignoreNextCardClick = false;
          }, 0);
        });
        issueCard.addEventListener('click', event => {
          if (ignoreNextCardClick) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          vscodeApi.postMessage({
            type: 'selectIssue',
            issueKey: issueCard.getAttribute('data-issue-key')
          });
        });
      }

      for (const dropZone of document.querySelectorAll('.column-body')) {
        dropZone.addEventListener('dragover', event => {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
          }
          dropZone.classList.add('drag-over');
          const indicator = getDropIndicator();
          const beforeCard = getInsertBeforeCard(dropZone, event.clientY);
          if (beforeCard) {
            dropZone.insertBefore(indicator, beforeCard);
          } else {
            dropZone.appendChild(indicator);
          }
        });
        dropZone.addEventListener('dragleave', event => {
          if (!dropZone.contains(event.relatedTarget)) {
            dropZone.classList.remove('drag-over');
            removeDropIndicator();
          }
        });
        dropZone.addEventListener('drop', event => {
          event.preventDefault();
          dropZone.classList.remove('drag-over');

          const column = dropZone.closest('.column');
          const targetStatus = column && column.getAttribute('data-column-status');
          const issueKey =
            (event.dataTransfer && event.dataTransfer.getData('text/plain')) || '';
          if (!issueKey || !targetStatus) {
            removeDropIndicator();
            return;
          }

          const beforeCard = getInsertBeforeCard(dropZone, event.clientY);
          const beforeKey = beforeCard ? beforeCard.getAttribute('data-issue-key') : null;
          removeDropIndicator();

          const draggedCard = document.querySelector('.issue-card.dragging');
          const sourceColumn = draggedCard && draggedCard.closest('.column');
          const sourceStatus = sourceColumn && sourceColumn.getAttribute('data-column-status');

          if (sourceStatus === targetStatus) {
            vscodeApi.postMessage({
              type: 'reorderIssue',
              issueKey,
              status: targetStatus,
              beforeKey
            });
          } else {
            vscodeApi.postMessage({
              type: 'moveIssue',
              issueKey,
              targetStatus
            });
          }
        });
      }

      let groupDropIndicator = null;
      let draggingGroupStatus = null;
      function getGroupDropIndicator() {
        if (!groupDropIndicator) {
          groupDropIndicator = document.createElement('div');
          groupDropIndicator.className = 'group-drop-indicator';
        }
        return groupDropIndicator;
      }
      function removeGroupDropIndicator() {
        if (groupDropIndicator && groupDropIndicator.parentNode) {
          groupDropIndicator.parentNode.removeChild(groupDropIndicator);
        }
      }

      const listView = document.querySelector('.list-view');
      if (listView) {
        for (const group of listView.querySelectorAll('.list-group')) {
          const handle = group.querySelector('.drag-handle');
          let handlePointerDown = false;
          if (handle) {
            handle.addEventListener('mousedown', () => { handlePointerDown = true; });
            document.addEventListener('mouseup', () => { handlePointerDown = false; });
          }

          group.addEventListener('dragstart', event => {
            if (!handlePointerDown) {
              event.preventDefault();
              return;
            }
            const status = group.getAttribute('data-group-status') || '';
            event.dataTransfer.setData('text/plain', status);
            event.dataTransfer.effectAllowed = 'move';
            draggingGroupStatus = status;
            group.classList.add('dragging-group');
          });

          group.addEventListener('dragend', () => {
            group.classList.remove('dragging-group');
            draggingGroupStatus = null;
            removeGroupDropIndicator();
            for (const g of listView.querySelectorAll('.list-group')) {
              g.classList.remove('drag-over-group');
            }
          });

          group.addEventListener('dragover', event => {
            if (!draggingGroupStatus || group.getAttribute('data-group-status') === draggingGroupStatus) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const rect = group.getBoundingClientRect();
            const indicator = getGroupDropIndicator();
            if (event.clientY < rect.top + rect.height / 2) {
              listView.insertBefore(indicator, group);
            } else {
              const next = group.nextElementSibling;
              if (next) {
                listView.insertBefore(indicator, next);
              } else {
                listView.appendChild(indicator);
              }
            }
          });

          group.addEventListener('dragleave', event => {
            if (!group.contains(event.relatedTarget)) {
              group.classList.remove('drag-over-group');
            }
          });

          group.addEventListener('drop', event => {
            event.preventDefault();
            removeGroupDropIndicator();
            if (!draggingGroupStatus) {
              return;
            }
            const targetStatus = group.getAttribute('data-group-status');
            if (targetStatus === draggingGroupStatus) {
              return;
            }
            const groups = [...listView.querySelectorAll('.list-group')];
            const currentOrder = groups.map(g => g.getAttribute('data-group-status'));
            const filtered = currentOrder.filter(s => s !== draggingGroupStatus);
            const targetIdx = filtered.indexOf(targetStatus);
            if (targetIdx === -1) {
              return;
            }
            const rect = group.getBoundingClientRect();
            const insertBefore = event.clientY < rect.top + rect.height / 2;
            filtered.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggingGroupStatus);
            vscodeApi.postMessage({ type: 'reorderGroups', orderedStatuses: filtered });
          });
        }

        for (const item of listView.querySelectorAll('.list-item')) {
          item.addEventListener('click', () => {
            vscodeApi.postMessage({
              type: 'selectIssue',
              issueKey: item.getAttribute('data-issue-key')
            });
          });
        }
      }
    </script>
  </body>
</html>`;
  }
}
