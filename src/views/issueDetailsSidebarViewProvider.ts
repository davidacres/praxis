import * as vscode from 'vscode';
import { DetailsViewProvider } from './detailsViewProvider';

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

function pillToken(label: string | undefined): string {
  const normalized = label?.trim().toLowerCase();
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
      return 'neutral';
  }
}

function renderPill(label: string | undefined): string {
  const value = label?.trim();
  if (!value) {
    return '';
  }
  return `<span class="pill pill--${pillToken(value)}">${escapeHtml(value)}</span>`;
}

export class IssueDetailsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly detailsProvider: DetailsViewProvider) {
    this.disposables.push(
      this.detailsProvider.onDidChangeTreeData(() => {
        this.render();
      })
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: false
    };
    this.render();
  }

  public dispose(): void {
    this.view = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const snapshot = this.detailsProvider.getSnapshot();
    const nonce = createNonce();
    let content = '';

    if (!snapshot.selectedIssue) {
      content = '<div class="message">Select an issue to inspect its details.</div>';
    } else if (snapshot.loading && !snapshot.detailedIssue) {
      content = `<div class="message">Loading ${escapeHtml(snapshot.selectedIssue.key)}...</div>`;
    } else if (snapshot.errorMessage) {
      content = `<div class="message error">${escapeHtml(snapshot.errorMessage)}</div>`;
    } else if (!snapshot.detailedIssue) {
      content = '<div class="message">Issue details are unavailable.</div>';
    } else {
      const issue = snapshot.detailedIssue;
      const rows = [
        ['Project', issue.projectName ? `${issue.projectKey} • ${issue.projectName}` : issue.projectKey || '—'],
        ['Assignee', issue.assignee ?? 'Unassigned'],
        ['Priority', issue.priority ?? '—'],
        ['Updated', issue.updated ?? '—']
      ]
        .map(
          ([label, value]) => `<div class="detail-row">
            <div class="detail-label">${escapeHtml(label)}</div>
            <div class="detail-value">${escapeHtml(value)}</div>
          </div>`
        )
        .join('');

      const description = issue.description?.trim()
        ? `<div class="detail-row" title="${escapeHtml(issue.description)}">
            <div class="detail-label">Description</div>
            <div class="detail-value">${escapeHtml(issue.description.replace(/\s+/g, ' ').trim())}</div>
          </div>`
        : '';

      const transitions = snapshot.transitions.length
        ? `<div class="detail-row">
            <div class="detail-label">Transitions</div>
            <div class="detail-pill-list">${snapshot.transitions
              .map(transition => renderPill(transition.toStatus ?? transition.name))
              .join('')}</div>
          </div>`
        : `<div class="detail-row">
            <div class="detail-label">Transitions</div>
            <div class="detail-value">No transitions available</div>
          </div>`;

      content = `<div class="item-list">
        <div class="issue-header" title="${escapeHtml(`${issue.key}: ${issue.summary}`)}">
          <div class="header-main">
            <div class="item-key">${escapeHtml(issue.key)}</div>
            ${renderPill(issue.issueType)}
            ${renderPill(issue.status)}
            <div class="item-summary">${escapeHtml(issue.summary)}</div>
          </div>
        </div>
        ${rows}
        ${description}
        ${transitions}
      </div>`;
    }

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
      }
      .page {
        box-sizing: border-box;
        min-height: 100%;
        padding: 10px;
      }
      .item-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .issue-header,
      .detail-row {
        width: 100%;
        box-sizing: border-box;
        padding: 4px 6px;
        border-radius: 4px;
      }
      .issue-header:hover,
      .detail-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .header-main,
      .detail-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .item-key {
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
      }
      .item-summary,
      .detail-value {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .detail-label {
        flex-shrink: 0;
        width: 78px;
        color: var(--vscode-descriptionForeground);
      }
      .pill {
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
      .pill--epic {
        color: #d8b4fe;
        background: rgba(168, 85, 247, 0.16);
        border-color: rgba(168, 85, 247, 0.28);
      }
      .pill--feature {
        color: #fdba74;
        background: rgba(249, 115, 22, 0.16);
        border-color: rgba(249, 115, 22, 0.28);
      }
      .pill--story {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        border-color: rgba(59, 130, 246, 0.28);
      }
      .pill--task {
        color: #86efac;
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(34, 197, 94, 0.28);
      }
      .pill--bug {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.16);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .pill--todo {
        color: #c4b5fd;
        background: rgba(124, 58, 237, 0.16);
        border-color: rgba(124, 58, 237, 0.28);
      }
      .pill--progress {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        border-color: rgba(59, 130, 246, 0.28);
      }
      .pill--blocked {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.16);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .pill--done {
        color: #86efac;
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(34, 197, 94, 0.28);
      }
      .pill--neutral {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .detail-pill-list {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        overflow: hidden;
      }
      .message {
        padding: 10px;
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
  </body>
</html>`;
  }
}
