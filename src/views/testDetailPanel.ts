import * as vscode from 'vscode';

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class TestDetailPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  public open(issueKey: string): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.testDetailPanel',
      `Test: ${issueKey}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    const nonce = createNonce();
    this.panel.webview.html = this.getHtml(nonce, issueKey);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private getHtml(nonce: string, issueKey: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Detail Panel</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    h1 { margin: 0 0 16px; font-size: 22px; color: var(--vscode-textLink-foreground); }
    .card {
      padding: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      margin-bottom: 16px;
    }
    .card h2 { margin: 0 0 8px; font-size: 14px; }
    .card p { margin: 0; font-size: 13px; line-height: 1.5; }
    .timestamp { margin-top: 16px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #counter-value { font-weight: 700; color: var(--vscode-textLink-foreground); }
    button {
      margin-top: 12px;
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h1>Test Panel - ${escapeHtml(issueKey)}</h1>

  <div class="card">
    <h2>Static Content</h2>
    <p>This is a test detail panel. If you can see this text, the webview is rendering correctly.</p>
    <p>Issue key: <strong>${escapeHtml(issueKey)}</strong></p>
  </div>

  <div class="card">
    <h2>Interactive Test</h2>
    <p>Counter: <span id="counter-value">0</span></p>
    <button id="increment-btn">Increment</button>
  </div>

  <div class="card">
    <h2>VS Code Theme Variables</h2>
    <p>If the cards above have visible borders and distinct backgrounds, theme CSS variables are working.</p>
  </div>

  <p class="timestamp">Rendered at: ${new Date().toISOString()}</p>

  <script nonce="${nonce}">
    let count = 0;
    const counterEl = document.getElementById('counter-value');
    const btn = document.getElementById('increment-btn');
    if (btn && counterEl) {
      btn.addEventListener('click', () => {
        count++;
        counterEl.textContent = String(count);
      });
    }
  </script>
</body>
</html>`;
  }
}
