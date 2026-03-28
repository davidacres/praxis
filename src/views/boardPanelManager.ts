import * as vscode from 'vscode';
import { findTransitionToTargetStatus } from '../board/boardTransitionResolver';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { BoardColumnStore } from '../state/boardColumnStore';
import type { Board, BoardDetails, IssueSummary } from '../types';
import { applyBoardColumnPreferences } from './boardColumnLayout';

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
  const parts = [issue.issueType, issue.assignee ?? 'Unassigned', issue.priority ?? 'Priority unknown'];
  return parts.join(' • ');
}

export class BoardPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeBoard?: Board;
  private boardDetails?: BoardDetails;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;
  private selectedIssueKey?: string;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly onIssueSelected: (issue: IssueSummary) => Promise<void>,
    private readonly onAfterBoardTransition: (() => Promise<void>) | undefined,
    private readonly boardColumnStore: BoardColumnStore
  ) {}

  public getActiveBoard(): Board | undefined {
    return this.activeBoard;
  }

  public refreshColumnLayout(): void {
    this.render();
  }

  public async openBoard(board: Board): Promise<void> {
    this.activeBoard = board;
    this.ensurePanel();
    this.panel?.reveal(vscode.ViewColumn.Active, false);
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.activeBoard) {
      return;
    }

    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;
    this.render();

    try {
      const boardDetails = await this.backendService.getBoardDetails(this.activeBoard);
      if (generation !== this.requestGeneration) {
        return;
      }

      this.boardDetails = boardDetails;
      this.loading = false;
      this.errorMessage = undefined;

      if (
        this.selectedIssueKey &&
        !boardDetails.issues.some(issue => issue.key === this.selectedIssueKey)
      ) {
        this.selectedIssueKey = undefined;
      }
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.boardDetails = undefined;
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
      vscode.ViewColumn.Active,
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
      const transitions = await this.backendService.getTransitions(issueKey);
      const transition = findTransitionToTargetStatus(transitions, targetStatus);
      if (!transition) {
        const hint =
          transitions.length > 0
            ? ` Available transitions: ${transitions
                .map(t => (t.toStatus ? `${t.name} → ${t.toStatus}` : t.name))
                .join('; ')}`
            : '';
        void vscode.window.showWarningMessage(
          `No workflow step moves ${issueKey} from "${issue.status}" to "${targetStatus}".${hint}`
        );
        return;
      }

      await this.backendService.transitionIssue(issueKey, transition.id);
      await this.refresh();
      await this.onAfterBoardTransition?.();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not move ${issueKey}: ${text}`);
    }
  }

  private getDisplayBoardDetails(): BoardDetails | undefined {
    if (!this.boardDetails || !this.activeBoard) {
      return this.boardDetails;
    }

    return applyBoardColumnPreferences(
      this.boardDetails,
      this.boardColumnStore.getPreferences(this.activeBoard.id)
    );
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

    let body = `
      <section class="empty-state">
        <h2>No board selected</h2>
        <p>Select a board from the Boards view.</p>
      </section>
    `;

    if (board) {
      if (this.loading) {
        body = `
          <section class="empty-state">
            <h2>Loading ${escapeHtml(board.name)}...</h2>
            <p>Fetching issues for the selected board.</p>
          </section>
        `;
      } else if (this.errorMessage) {
        body = `
          <section class="empty-state error">
            <h2>Unable to load board</h2>
            <p>${escapeHtml(this.errorMessage)}</p>
          </section>
        `;
      } else if (this.boardDetails) {
        const display = this.getDisplayBoardDetails() ?? this.boardDetails;
        body =
          display.columns.length === 0
            ? `
                <section class="empty-state">
                  <h2>No issues on this board</h2>
                  <p>The selected board does not currently contain any issues.</p>
                </section>
              `
            : `
                <section class="board-grid">
                  ${display.columns
                    .map(
                      column => `
                        <section class="column" data-column-status="${escapeHtml(column.name)}">
                          <header class="column-header">
                            <h2>${escapeHtml(column.name)}</h2>
                            <span>${column.issues.length}</span>
                          </header>
                          <div class="column-body" data-drop-target="true">
                            ${column.issues
                              .map(
                                issue => `
                                  <div class="issue-card${this.selectedIssueKey === issue.key ? ' selected' : ''}" draggable="true" data-issue-key="${escapeHtml(issue.key)}">
                                    <button type="button" class="issue-key-btn" data-issue-key="${escapeHtml(issue.key)}">${escapeHtml(issue.key)}</button>
                                    <span class="issue-summary">${escapeHtml(issue.summary)}</span>
                                    <span class="issue-meta">${escapeHtml(formatIssueMeta(issue))}</span>
                                  </div>
                                `
                              )
                              .join('')}
                          </div>
                        </section>
                      `
                    )
                    .join('')}
                </section>
              `;
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
      }

      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }

      .page {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }

      .header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
      }

      .header h1 {
        margin: 0;
        font-size: 18px;
      }

      .header p {
        margin: 4px 0 0;
        color: var(--vscode-descriptionForeground);
      }

      .header-actions {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 8px;
      }

      .refresh-button {
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-radius: 6px;
        padding: 6px 12px;
        cursor: pointer;
      }

      .refresh-button:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .content {
        padding: 16px 20px 20px;
      }

      .board-grid {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(260px, 1fr);
        gap: 16px;
        align-items: start;
        overflow-x: auto;
        padding-bottom: 8px;
      }

      .column {
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 120px);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-sideBar-background);
      }

      .column-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .column-header h2 {
        margin: 0;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .column-header span {
        color: var(--vscode-descriptionForeground);
      }

      .column-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        overflow-y: auto;
      }

      .issue-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        padding: 12px;
        text-align: left;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        color: inherit;
        cursor: grab;
        box-sizing: border-box;
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
    </style>
  </head>
  <body>
    <div class="page">
      <header class="header">
        <div>
          <h1>${headerTitle}</h1>
          <p>${headerMeta}</p>
        </div>
        <div class="header-actions">
          <button class="refresh-button" id="columnsButton" type="button">Columns</button>
          <button class="refresh-button" id="refreshButton" type="button">Refresh</button>
        </div>
      </header>
      <main class="content">${body}</main>
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
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
        });
        dropZone.addEventListener('dragleave', event => {
          if (!dropZone.contains(event.relatedTarget)) {
            dropZone.classList.remove('drag-over');
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
            return;
          }
          vscodeApi.postMessage({
            type: 'moveIssue',
            issueKey,
            targetStatus
          });
        });
      }
    </script>
  </body>
</html>`;
  }
}
