import * as vscode from 'vscode';
import type { IssueDetails } from '@ticket-manager/core';
import type { LprResult } from '@ticket-manager/core';
import { markdownToHtmlSafe, MARKDOWN_BODY_CSS } from '@ticket-manager/core';
import { renderIconButton } from './webviewToolbarIcons';

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

type LprState =
  | { phase: 'idle' }
  | { phase: 'running'; step: string }
  | { phase: 'done'; result: LprResult }
  | { phase: 'error'; message: string };

export class LocalPeerReviewPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private issue?: IssueDetails;
  private state: LprState = { phase: 'idle' };

  public constructor(
    private readonly runReview: (issue: IssueDetails) => Promise<LprResult>
  ) {}

  public async open(issue: IssueDetails): Promise<void> {
    this.issue = issue;
    this.state = { phase: 'running', step: 'Starting review...' };
    this.disposePanel();
    this.createPanel();
    this.panel?.reveal(vscode.ViewColumn.Active, false);

    try {
      const result = await this.runReview(issue);
      this.state = { phase: 'done', result };
    } catch (error) {
      this.state = {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error)
      };
    }

    // Dispose and recreate to set html synchronously with final state
    this.disposePanel();
    this.createPanel();
  }

  public dispose(): void {
    this.disposePanel();
  }

  private disposePanel(): void {
    const p = this.panel;
    this.panel = undefined;
    p?.dispose();
  }

  private createPanel(): void {
    const issueKey = this.issue?.key ?? 'LPR';
    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.localPeerReview',
      `LPR: ${issueKey}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'refresh' && this.issue) {
        void this.open(this.issue);
      }
    });

    panel.webview.html = this.getHtml(nonce);
    this.panel = panel;

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
  }

  private render(): void {
    if (!this.panel) {
      return;
    }
    this.disposePanel();
    this.createPanel();
  }

  private getHtml(nonce: string): string {
    const issue = this.issue;
    const title = issue ? `LPR: ${escapeHtml(issue.key)}` : 'Local Peer Review';
    const subtitle = issue ? escapeHtml(issue.summary) : '';

    let bodyContent: string;

    if (this.state.phase === 'running') {
      bodyContent = `
        <section class="lpr-section">
          <div class="lpr-loading">
            <div class="spinner"></div>
            <span>${escapeHtml(this.state.step)}</span>
          </div>
        </section>`;
    } else if (this.state.phase === 'error') {
      bodyContent = `
        <section class="lpr-section lpr-error">
          <h3>Error</h3>
          <p>${escapeHtml(this.state.message)}</p>
        </section>`;
    } else if (this.state.phase === 'done' && issue) {
      const r = this.state.result;
      bodyContent = `
        ${this.renderTicketSummary(issue)}

        <section class="lpr-section">
          <h3>
            <span class="section-icon section-icon--summary">◉</span>
            Summary &amp; Verdict
          </h3>
          <div class="lpr-body markdown-body">${markdownToHtmlSafe(r.summary)}</div>
        </section>

        <section class="lpr-section">
          <h3>
            <span class="section-icon section-icon--code">◉</span>
            Code Review
          </h3>
          <div class="lpr-body markdown-body">${markdownToHtmlSafe(r.codeReview)}</div>
        </section>

        <section class="lpr-section">
          <h3>
            <span class="section-icon section-icon--security">◉</span>
            Security Review
          </h3>
          <div class="lpr-body markdown-body">${markdownToHtmlSafe(r.securityReview)}</div>
        </section>`;
    } else {
      bodyContent = `
        <section class="lpr-section">
          <p>Select an issue and run a Local Peer Review.</p>
        </section>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      padding: 0;
      display: flex;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .page {
      display: flex;
      flex: 1;
      width: 100%;
      min-height: 100vh;
      padding: 8px;
    }
    .content-shell {
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
    .lpr-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: rgba(96, 165, 250, 0.1);
      border: 1px solid rgba(96, 165, 250, 0.2);
      color: #93c5fd;
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
    .content {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 16px;
      min-height: 0;
      padding: 16px;
      overflow-y: auto;
    }
    .lpr-section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .lpr-section h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-icon {
      font-size: 10px;
    }
    .section-icon--summary { color: #93c5fd; }
    .section-icon--code { color: #86efac; }
    .section-icon--security { color: #fca5a5; }
    .section-icon--ticket { color: #c4b5fd; }
    .lpr-section.lpr-error {
      border-color: var(--vscode-errorForeground);
    }
    .lpr-section.lpr-error h3 {
      color: var(--vscode-errorForeground);
    }
    .lpr-body {
      line-height: 1.6;
      word-break: break-word;
    }
    .lpr-loading {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      color: var(--vscode-descriptionForeground);
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .ticket-meta {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 4px 12px;
      font-size: 13px;
    }
    .ticket-meta-label {
      color: var(--vscode-descriptionForeground);
    }
    .ticket-meta-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.4;
    }
    .pill--status {
      color: #a1a1aa;
      background: rgba(161, 161, 170, 0.1);
      border-color: rgba(161, 161, 170, 0.2);
    }
    .pill--type {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.1);
      border-color: rgba(59, 130, 246, 0.2);
    }
    .pill--priority {
      color: #fdba74;
      background: rgba(249, 115, 22, 0.1);
      border-color: rgba(249, 115, 22, 0.2);
    }
    ${MARKDOWN_BODY_CSS}
  </style>
</head>
<body>
  <div class="page">
    <div class="content-shell">
      <header class="panel-header">
        <div class="panel-header-main">
          <h1>${escapeHtml(title)} <span class="lpr-badge">Local Peer Review</span></h1>
          ${subtitle ? `<p class="panel-subtitle">${subtitle}</p>` : ''}
        </div>
        ${renderIconButton('refreshBtn', 'Re-run review', 'refresh')}
      </header>
      <main class="content">
        ${bodyContent}
      </main>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
  </script>
</body>
</html>`;
  }

  private renderTicketSummary(d: IssueDetails): string {
    const descriptionHtml = d.description?.trim()
      ? markdownToHtmlSafe(d.description)
      : '<em>No description provided.</em>';

    return `
      <section class="lpr-section">
        <h3>
          <span class="section-icon section-icon--ticket">◉</span>
          Ticket Details
        </h3>
        <div class="ticket-meta">
          <span class="ticket-meta-label">Key</span>
          <span class="ticket-meta-value">${escapeHtml(d.key)}</span>
          <span class="ticket-meta-label">Type</span>
          <span class="ticket-meta-value"><span class="pill pill--type">${escapeHtml(d.issueType)}</span></span>
          <span class="ticket-meta-label">Status</span>
          <span class="ticket-meta-value"><span class="pill pill--status">${escapeHtml(d.status)}</span></span>
          <span class="ticket-meta-label">Priority</span>
          <span class="ticket-meta-value"><span class="pill pill--priority">${escapeHtml(d.priority ?? 'Unset')}</span></span>
          <span class="ticket-meta-label">Assignee</span>
          <span class="ticket-meta-value">${escapeHtml(d.assignee ?? 'Unassigned')}</span>
        </div>
        <div class="lpr-body markdown-body">${descriptionHtml}</div>
      </section>`;
  }
}
