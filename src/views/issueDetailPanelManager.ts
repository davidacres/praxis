import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, IssueSummary, WorkflowTransition } from '../types';
import { renderIconButton } from './webviewToolbarIcons';

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

function isParentIssueType(issueType: string | undefined): boolean {
  const normalized = issueType?.trim().toLowerCase();
  return normalized === 'epic' || normalized === 'feature';
}

export class IssueDetailPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeIssueKey?: string;
  private details?: IssueDetails;
  private transitions: WorkflowTransition[] = [];
  private parentItems: IssueSummary[] = [];
  private parentItemsError?: string;
  private loading = false;
  private errorMessage?: string;
  private requestGeneration = 0;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly onAfterTransition: () => Promise<void>
  ) {}

  public async open(issueKey: string): Promise<void> {
    this.activeIssueKey = issueKey;
    this.ensurePanel(issueKey);
    this.panel?.reveal(vscode.ViewColumn.Beside, false);
    await this.refresh();
  }

  public async refreshIfShowing(issueKey: string): Promise<void> {
    if (this.activeIssueKey === issueKey && this.panel) {
      await this.refresh();
    }
  }

  public clear(): void {
    this.activeIssueKey = undefined;
    this.details = undefined;
    this.transitions = [];
    this.parentItems = [];
    this.parentItemsError = undefined;
    this.loading = false;
    this.errorMessage = undefined;
    this.requestGeneration += 1;
    this.panel?.dispose();
    this.panel = undefined;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(issueKey: string): void {
    if (this.panel) {
      this.panel.title = issueKey;
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.issueDetailPanel',
      issueKey,
      vscode.ViewColumn.Beside,
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

    if (!this.activeIssueKey) {
      return;
    }

    if (type === 'assignParent') {
      try {
        const parentKey = Object.prototype.hasOwnProperty.call(message, 'parentKey')
          ? asString(message.parentKey) ?? null
          : null;
        await this.backendService.updateIssue(this.activeIssueKey, { parentKey });
        await this.onAfterTransition();
        await this.refresh();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`EPIC update failed: ${text}`);
      }
      return;
    }

    if (type !== 'transition') {
      return;
    }

    const transitionId = asString(message.transitionId);
    if (!transitionId) {
      return;
    }

    try {
      await this.backendService.transitionIssue(this.activeIssueKey, transitionId);
      await this.onAfterTransition();
      await this.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Transition failed: ${text}`);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.activeIssueKey) {
      return;
    }

    const issueKey = this.activeIssueKey;
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.errorMessage = undefined;
    this.render();

    try {
      const [issue, transitions] = await Promise.all([
        this.backendService.getIssue(issueKey),
        this.backendService.getTransitions(issueKey)
      ]);

      let parentItems: IssueSummary[] = [];
      let parentItemsError: string | undefined;
      if (!isParentIssueType(issue.issueType) && issue.projectKey) {
        try {
          parentItems = (await this.backendService.getParentItems(
            {
              projectKeys: [issue.projectKey],
              statuses: [],
              issueTypes: [],
              searchText: '',
              assigneeMode: 'all',
              parentKey: undefined,
              grouping: 'none'
            },
            undefined
          )).filter(item => item.key !== issue.key);
        } catch (error) {
          parentItems = [];
          parentItemsError = error instanceof Error ? error.message : String(error);
        }
      }

      if (generation !== this.requestGeneration) {
        return;
      }

      this.details = { ...issue, transitions };
      this.transitions = transitions;
      this.parentItems = parentItems;
      this.parentItemsError = parentItemsError;
      this.loading = false;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.details = undefined;
      this.transitions = [];
      this.parentItems = [];
      this.parentItemsError = undefined;
    } finally {
      if (generation === this.requestGeneration) {
        this.render();
      }
    }
  }

  private render(): void {
    if (!this.panel) {
      return;
    }

    const issueKey = this.activeIssueKey ?? 'Issue';
    this.panel.title = issueKey;
    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const issueKey = escapeHtml(this.activeIssueKey ?? '');

    if (this.loading) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state"><h2>Loading ${issueKey}…</h2></section>`,
        `Loading ${issueKey}…`
      );
    }

    if (this.errorMessage) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state error"><h2>Unable to load issue</h2><p>${escapeHtml(this.errorMessage)}</p></section>`,
        issueKey || 'Issue'
      );
    }

    if (!this.details) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state"><h2>No issue data</h2></section>`,
        issueKey || 'Issue'
      );
    }

    const d = this.details;
    const description = d.description?.trim()
      ? `<section class="block"><h3>Description</h3><pre class="description-body">${escapeHtml(d.description)}</pre></section>`
      : '';
    const epicAssignment =
      !isParentIssueType(d.issueType)
        ? `<section class="block">
            <h3>EPIC</h3>
            <div class="select-row">
              <select id="parentSelect" class="parent-select">
                <option value="">No EPIC</option>
                ${this.parentItems
                  .map(
                    item => `<option value="${escapeHtml(item.key)}" ${item.key === d.parentKey ? 'selected' : ''}>
                      ${escapeHtml(`${item.key} • ${item.summary}`)}
                    </option>`
                  )
                  .join('')}
              </select>
            </div>
            ${this.parentItemsError ? `<p class="muted error-text">${escapeHtml(this.parentItemsError)}</p>` : ''}
          </section>`
        : '';

    const transitions =
      this.transitions.length > 0
        ? `<section class="block"><h3>Transitions</h3><div class="transition-row">${this.transitions
            .map(
              t => `
          <button type="button" class="transition-btn" data-transition-id="${escapeHtml(t.id)}">
            ${escapeHtml(t.name)}${t.toStatus ? ` → ${escapeHtml(t.toStatus)}` : ''}
          </button>`
            )
            .join('')}</div></section>`
        : '<p class="muted">No transitions available for this issue.</p>';

    const metaRows = [
      ['Project', d.projectName ? `${d.projectKey} • ${d.projectName}` : d.projectKey ?? '—'],
      ['Status', d.status],
      ['Type', d.issueType],
      ['Assignee', d.assignee ?? 'Unassigned'],
      ['Priority', d.priority ?? '—'],
      ['Updated', d.updated ?? '—']
    ]
      .map(
        ([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`
      )
      .join('');

    const body = `
      <table class="meta-table">${metaRows}</table>
      ${epicAssignment}
      ${description}
      ${transitions}
    `;

    return this.wrapPage(nonce, issueKey, body, escapeHtml(d.key), escapeHtml(d.summary));
  }

  private wrapPage(
    nonce: string,
    title: string,
    body: string,
    headerTitle: string = title,
    headerSubtitle?: string
  ): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
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
    .content-shell {
      box-sizing: border-box;
      display: flex;
      flex: 1;
      flex-direction: column;
      width: 100%;
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    .content {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 20px;
      min-height: 0;
      padding: 16px;
      overflow-y: auto;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .panel-header-main {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .panel-header h1 {
      margin: 0;
      font-size: 22px;
      color: var(--vscode-textLink-foreground);
    }
    .panel-subtitle {
      margin: 0;
      font-size: 15px;
      line-height: 1.45;
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
      flex-shrink: 0;
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
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .meta-table th {
      text-align: left;
      width: 120px;
      padding: 6px 12px 6px 0;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      vertical-align: top;
    }
    .meta-table td { padding: 6px 0; }
    .block h3 {
      margin: 0 0 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .description-body {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.5;
      padding: 12px 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-sideBar-background));
    }
    .select-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .parent-select {
      min-width: 280px;
      max-width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    }
    .transition-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .transition-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .transition-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .empty-state {
      flex: 1;
      padding: 24px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state h2 {
      margin-top: 0;
      color: var(--vscode-editor-foreground);
    }
    .empty-state.error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); font-size: 13px; }
    .error-text { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="page">
    <div class="content-shell">
      <header class="panel-header">
        <div class="panel-header-main">
          <h1>${headerTitle}</h1>
          ${headerSubtitle ? `<p class="panel-subtitle">${headerSubtitle}</p>` : ''}
        </div>
        ${renderIconButton('refreshBtn', 'Refresh', 'refresh')}
      </header>
      <main class="content">
        ${body}
      </main>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
    }
    for (const btn of document.querySelectorAll('.transition-btn')) {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-transition-id');
        if (id) vscodeApi.postMessage({ type: 'transition', transitionId: id });
      });
    }
    const parentSelect = document.getElementById('parentSelect');
    if (parentSelect) {
      parentSelect.addEventListener('change', () => {
        vscodeApi.postMessage({
          type: 'assignParent',
          parentKey: parentSelect.value || null
        });
      });
    }
  </script>
</body>
</html>`;
  }
}
