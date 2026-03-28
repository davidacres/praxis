import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { JiraBoard, JiraBoardDetails, JiraIssueSummary } from '../types';

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

function formatIssueMeta(issue: JiraIssueSummary): string {
  const parts = [issue.issueType, issue.assignee ?? 'Unassigned', issue.priority ?? 'Priority unknown'];
  return parts.join(' • ');
}

export class BoardPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeBoard?: JiraBoard;
  private boardDetails?: JiraBoardDetails;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;
  private selectedIssueKey?: string;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly onIssueSelected: (issue: JiraIssueSummary) => Promise<void>
  ) {}

  public async openBoard(board: JiraBoard): Promise<void> {
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
    return {
      boardId: this.activeBoard?.id,
      boardName: this.activeBoard?.name,
      issueCount: this.boardDetails?.issues.length ?? 0,
      columnNames: this.boardDetails?.columns.map(column => column.name) ?? [],
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
      'jiraMini.boardPanel',
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
        <p>Select a board from the Jira Mini Boards view.</p>
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
        body =
          this.boardDetails.columns.length === 0
            ? `
                <section class="empty-state">
                  <h2>No issues on this board</h2>
                  <p>The selected board does not currently contain any issues.</p>
                </section>
              `
            : `
                <section class="board-grid">
                  ${this.boardDetails.columns
                    .map(
                      column => `
                        <section class="column">
                          <header class="column-header">
                            <h2>${escapeHtml(column.name)}</h2>
                            <span>${column.issues.length}</span>
                          </header>
                          <div class="column-body">
                            ${column.issues
                              .map(
                                issue => `
                                  <button class="issue-card${this.selectedIssueKey === issue.key ? ' selected' : ''}" data-issue-key="${escapeHtml(issue.key)}">
                                    <span class="issue-key">${escapeHtml(issue.key)}</span>
                                    <span class="issue-summary">${escapeHtml(issue.summary)}</span>
                                    <span class="issue-meta">${escapeHtml(formatIssueMeta(issue))}</span>
                                  </button>
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
        cursor: pointer;
      }

      .issue-card:hover {
        border-color: var(--vscode-focusBorder);
      }

      .issue-card.selected {
        border-color: var(--vscode-focusBorder);
        box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
      }

      .issue-key {
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
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
        <button class="refresh-button" id="refreshButton" type="button">Refresh</button>
      </header>
      <main class="content">${body}</main>
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      const refreshButton = document.getElementById('refreshButton');
      if (refreshButton) {
        refreshButton.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'refresh' });
        });
      }

      for (const issueCard of document.querySelectorAll('.issue-card')) {
        issueCard.addEventListener('click', () => {
          vscodeApi.postMessage({
            type: 'selectIssue',
            issueKey: issueCard.getAttribute('data-issue-key')
          });
        });
      }
    </script>
  </body>
</html>`;
  }
}
