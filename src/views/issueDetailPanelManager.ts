import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, WorkflowTransition } from '../types';

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

export class IssueDetailPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private activeIssueKey?: string;
  private details?: IssueDetails;
  private transitions: WorkflowTransition[] = [];
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

    if (type !== 'transition' || !this.activeIssueKey) {
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

      if (generation !== this.requestGeneration) {
        return;
      }

      this.details = { ...issue, transitions };
      this.transitions = transitions;
      this.loading = false;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.details = undefined;
      this.transitions = [];
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
        `<section class="empty-state"><h2>Loading ${issueKey}…</h2></section>`
      );
    }

    if (this.errorMessage) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state error"><h2>Unable to load issue</h2><p>${escapeHtml(this.errorMessage)}</p></section>`
      );
    }

    if (!this.details) {
      return this.wrapPage(
        nonce,
        issueKey,
        `<section class="empty-state"><h2>No issue data</h2></section>`
      );
    }

    const d = this.details;
    const description = d.description?.trim()
      ? `<section class="block"><h3>Description</h3><pre class="description-body">${escapeHtml(d.description)}</pre></section>`
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
      <section class="hero">
        <h1>${escapeHtml(d.key)}</h1>
        <p class="summary">${escapeHtml(d.summary)}</p>
      </section>
      <table class="meta-table">${metaRows}</table>
      ${description}
      ${transitions}
    `;

    return this.wrapPage(nonce, issueKey, body);
  }

  private wrapPage(nonce: string, title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .page { padding: 20px 24px 32px; max-width: 880px; }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
    }
    .refresh-button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
    }
    .refresh-button:hover { background: var(--vscode-button-hoverBackground); }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 22px;
      color: var(--vscode-textLink-foreground);
    }
    .summary { margin: 0 0 20px; font-size: 15px; line-height: 1.45; }
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
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
    .block { margin-bottom: 20px; }
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
    .empty-state { padding: 24px; }
    .empty-state.error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); font-size: 13px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="toolbar">
      <button class="refresh-button" id="refreshBtn" type="button">Refresh</button>
    </div>
    ${body}
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
  </script>
</body>
</html>`;
  }
}
