import * as vscode from 'vscode';

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

export class SetupSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'ticketManager.setup';

  private view?: vscode.WebviewView;
  private setupStep: 0 | 1 = 0;
  private setupMode: string | undefined;
  private setupFields: Record<string, string> = {};
  private readonly disposables: vscode.Disposable[] = [];

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
    this.render();
  }

  public dispose(): void {
    this.view = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const nonce = createNonce();
    const content = this.setupStep === 0 ? this.renderStepZero() : this.renderStepOne();

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
        padding: 12px 10px;
      }

      /* Header */
      .header { margin-bottom: 12px; }
      .header h2 {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 600;
      }
      .header p {
        margin: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      /* Step 0 – card list */
      .card-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border: 1px solid var(--vscode-widget-border, transparent);
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
      }
      .card:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .card-emoji {
        font-size: 18px;
        line-height: 1;
      }
      .card-title {
        font-size: 13px;
        font-weight: 700;
      }
      .card-desc {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      /* Step 1 – form */
      .form-group {
        margin-bottom: 12px;
      }
      .form-group label {
        display: block;
        font-size: 12px;
        color: var(--vscode-foreground);
        margin-bottom: 4px;
      }
      .form-group input[type="text"],
      .form-group input[type="password"] {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
        border-radius: 3px;
        outline: none;
      }
      .form-group input[type="text"]:focus,
      .form-group input[type="password"]:focus {
        border-color: var(--vscode-focusBorder);
      }
      .radio-group {
        display: inline-flex;
        gap: 12px;
        align-items: center;
        font-size: 12px;
      }
      .radio-group label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 0;
        cursor: pointer;
      }
      .help-text {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 4px;
      }
      .help-text a {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
      }
      .help-text a:hover {
        text-decoration: underline;
      }
      .info-text {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 12px;
      }

      /* Buttons */
      .footer {
        display: flex;
        gap: 8px;
        margin-top: 16px;
      }
      .btn {
        flex: 1;
        height: 30px;
        border: none;
        border-radius: 3px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        width: 100%;
      }
      .btn-primary {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
      }
      .btn-primary:hover {
        background: var(--vscode-button-hoverBackground);
      }
      .btn-secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      .btn-secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
      .btn-browse {
        margin-top: 4px;
        width: 100%;
        height: 28px;
        border: 1px solid var(--vscode-widget-border, transparent);
        border-radius: 3px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        cursor: pointer;
      }
      .btn-browse:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${content}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();

      document.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        if (action === 'selectMode') {
          vscodeApi.postMessage({ type: 'selectMode', mode: el.dataset.mode });
        } else if (action === 'back') {
          vscodeApi.postMessage({ type: 'back' });
        } else if (action === 'save') {
          vscodeApi.postMessage({ type: 'save' });
        } else if (action === 'browse') {
          vscodeApi.postMessage({ type: 'browse' });
        }
      });

      document.addEventListener('input', e => {
        if (e.target.dataset.field) {
          vscodeApi.postMessage({ type: 'updateField', field: e.target.dataset.field, value: e.target.value });
        }
      });

      document.addEventListener('change', e => {
        if (e.target.dataset.field) {
          vscodeApi.postMessage({ type: 'updateField', field: e.target.dataset.field, value: e.target.value });
        }
      });
    </script>
  </body>
</html>`;
  }

  private renderStepZero(): string {
    const modes: Array<{ mode: string; emoji: string; title: string; desc: string }> = [
      { mode: 'file', emoji: '🗂️', title: 'Plan File', desc: 'Manage tickets from a local JSON plan file' },
      { mode: 'livefolder', emoji: '📂', title: 'Live Folder', desc: 'Two-way sync with a markdown plans folder' },
      { mode: 'github', emoji: '🐙', title: 'GitHub', desc: 'Connect to GitHub repositories and issues' },
      { mode: 'gitlab', emoji: '🦊', title: 'GitLab', desc: 'Connect to a GitLab instance for issues and boards' },
      { mode: 'jira', emoji: '🔗', title: 'Jira', desc: 'Connect to Jira via MCP server' },
      { mode: 'demo', emoji: '🎭', title: 'Demo', desc: 'Try with sample data, no configuration needed' }
    ];

    const cards = modes
      .map(
        m =>
          `<div class="card" data-action="selectMode" data-mode="${escapeHtml(m.mode)}">
            <span class="card-emoji">${m.emoji}</span>
            <span class="card-title">${escapeHtml(m.title)}</span>
            <span class="card-desc">${escapeHtml(m.desc)}</span>
          </div>`
      )
      .join('');

    return `<div class="header">
  <h2>Configure Project</h2>
  <p>Choose how you want to manage your tickets.</p>
</div>
<div class="card-list">
  ${cards}
</div>`;
  }

  private renderStepOne(): string {
    let fields = '';

    switch (this.setupMode) {
      case 'file':
        fields = this.renderFileFields();
        break;
      case 'livefolder':
        fields = this.renderLiveFolderFields();
        break;
      case 'github':
        fields = this.renderGitHubFields();
        break;
      case 'gitlab':
        fields = this.renderGitLabFields();
        break;
      case 'jira':
        fields = this.renderJiraFields();
        break;
      case 'demo':
        fields = '<p class="info-text">Demo mode uses sample data — no additional configuration needed.</p>';
        break;
      default:
        fields = '';
    }

    return `<div class="header">
  <h2>Configure Project</h2>
</div>
${fields}
<div class="footer">
  <button class="btn btn-secondary" data-action="back">\u2190 Back</button>
  <button class="btn btn-primary" data-action="save">Save &amp; Connect</button>
</div>`;
  }

  private renderFileFields(): string {
    const value = escapeHtml(this.setupFields.planFilePath ?? '');
    return `<div class="form-group">
  <label>Plan File Path</label>
  <input type="text" data-field="planFilePath" value="${value}" />
  <button class="btn-browse" data-action="browse">Browse\u2026</button>
</div>`;
  }

  private renderLiveFolderFields(): string {
    const folderPath = escapeHtml(this.setupFields.liveFolderPath ?? '');
    const projectKey = escapeHtml(this.setupFields.liveFolderProjectKey ?? '');
    const projectName = escapeHtml(this.setupFields.liveFolderProjectName ?? '');
    return `<div class="form-group">
  <label>Plans Folder Path</label>
  <input type="text" data-field="liveFolderPath" value="${folderPath}" placeholder="e.g. C:\\project\\plans" />
  <button class="btn-browse" data-action="browse">Browse\u2026</button>
  <div class="help-text">Folder containing features/feature-NN-*/feature.md</div>
</div>
<div class="form-group">
  <label>Project Key</label>
  <input type="text" data-field="liveFolderProjectKey" value="${projectKey}" placeholder="e.g. EXAMPLE" />
</div>
<div class="form-group">
  <label>Project Name</label>
  <input type="text" data-field="liveFolderProjectName" value="${projectName}" placeholder="e.g. ExampleHIS Integration" />
</div>`;
  }

  private renderGitHubFields(): string {
    const url = escapeHtml(this.setupFields.githubUrl ?? 'https://api.github.com');
    const pat = escapeHtml(this.setupFields.githubPat ?? '');
    const owner = escapeHtml(this.setupFields.githubOwner ?? '');
    return `<div class="form-group">
  <label>API URL</label>
  <input type="text" data-field="githubUrl" value="${url}" />
</div>
<div class="form-group">
  <label>Personal Access Token</label>
  <input type="password" data-field="githubPat" value="${pat}" />
  <div class="help-text"><a href="https://github.com/settings/tokens">Create a token</a></div>
</div>
<div class="form-group">
  <label>Owner / Organisation</label>
  <input type="text" data-field="githubOwner" value="${owner}" />
</div>`;
  }

  private renderGitLabFields(): string {
    const url = escapeHtml(this.setupFields.gitlabUrl ?? '');
    const connType = this.setupFields.gitlabConnectionType ?? 'api';
    const apiChecked = connType === 'api' ? ' checked' : '';
    const mcpChecked = connType === 'mcp' ? ' checked' : '';

    let connFields = '';
    if (connType === 'api') {
      const apiKey = escapeHtml(this.setupFields.gitlabApiKey ?? '');
      connFields = `<div class="form-group">
  <label>API Key</label>
  <input type="password" data-field="gitlabApiKey" value="${apiKey}" />
</div>`;
    } else {
      const cmd = escapeHtml(this.setupFields.gitlabMcpCommand ?? '');
      const args = escapeHtml(this.setupFields.gitlabMcpArgs ?? '');
      connFields = `<div class="form-group">
  <label>MCP Command</label>
  <input type="text" data-field="gitlabMcpCommand" value="${cmd}" />
</div>
<div class="form-group">
  <label>Arguments</label>
  <input type="text" data-field="gitlabMcpArgs" value="${args}" />
</div>`;
    }

    return `<div class="form-group">
  <label>GitLab URL</label>
  <input type="text" data-field="gitlabUrl" value="${url}" placeholder="https://gitlab.com" />
</div>
<div class="form-group">
  <label>Connection Type</label>
  <div class="radio-group">
    <label><input type="radio" name="gitlabConnectionType" data-field="gitlabConnectionType" value="api"${apiChecked} /> API Key</label>
    <label><input type="radio" name="gitlabConnectionType" data-field="gitlabConnectionType" value="mcp"${mcpChecked} /> MCP Server</label>
  </div>
</div>
${connFields}
<div class="help-text">Create a token in GitLab \u2192 Settings \u2192 Access Tokens</div>`;
  }

  private renderJiraFields(): string {
    const connType = this.setupFields.jiraConnectionType ?? 'stdio';
    const stdioChecked = connType === 'stdio' ? ' checked' : '';
    const httpChecked = connType === 'http' ? ' checked' : '';

    let connFields = '';
    if (connType === 'stdio') {
      const cmd = escapeHtml(this.setupFields.jiraStdioCommand ?? '');
      const args = escapeHtml(this.setupFields.jiraStdioArgs ?? '');
      const cwd = escapeHtml(this.setupFields.jiraCwd ?? '');
      connFields = `<div class="form-group">
  <label>Command</label>
  <input type="text" data-field="jiraStdioCommand" value="${cmd}" />
</div>
<div class="form-group">
  <label>Arguments</label>
  <input type="text" data-field="jiraStdioArgs" value="${args}" />
</div>
<div class="form-group">
  <label>Working Directory</label>
  <input type="text" data-field="jiraCwd" value="${cwd}" />
</div>`;
    } else {
      const httpUrl = escapeHtml(this.setupFields.jiraHttpUrl ?? '');
      connFields = `<div class="form-group">
  <label>Server URL</label>
  <input type="text" data-field="jiraHttpUrl" value="${httpUrl}" />
</div>`;
    }

    return `<div class="form-group">
  <label>Connection Type</label>
  <div class="radio-group">
    <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="stdio"${stdioChecked} /> Local MCP (stdio)</label>
    <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="http"${httpChecked} /> Remote MCP (HTTP)</label>
  </div>
</div>
${connFields}`;
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
      case 'selectMode': {
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
      case 'back':
        this.setupStep = 0;
        this.render();
        return;
      case 'updateField': {
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
      case 'browse': {
        if (this.setupMode === 'livefolder') {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Plans Folder'
          });
          if (uris?.[0]) {
            this.setupFields.liveFolderPath = uris[0].fsPath;
            this.render();
          }
        } else {
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
        }
        return;
      }
      case 'save':
        await this.saveSetupConfiguration();
        return;
    }
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
      case 'livefolder':
        if (this.setupFields.liveFolderPath) {
          await config.update('liveFolderPath', this.setupFields.liveFolderPath, target);
        }
        if (this.setupFields.liveFolderProjectKey) {
          await config.update('liveFolderProjectKey', this.setupFields.liveFolderProjectKey, target);
        }
        if (this.setupFields.liveFolderProjectName) {
          await config.update('liveFolderProjectName', this.setupFields.liveFolderProjectName, target);
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
      case 'gitlab': {
        if (this.setupFields.gitlabUrl) {
          await config.update('gitlabUrl', this.setupFields.gitlabUrl, target);
        }
        const glConn = this.setupFields.gitlabConnectionType || 'api';
        await config.update('gitlabConnectionType', glConn, target);
        if (glConn === 'api' && this.setupFields.gitlabApiKey) {
          await config.update('gitlabApiKey', this.setupFields.gitlabApiKey, target);
        } else if (glConn === 'mcp') {
          if (this.setupFields.gitlabMcpCommand) {
            await config.update('gitlabMcpCommand', this.setupFields.gitlabMcpCommand, target);
          }
          if (this.setupFields.gitlabMcpArgs) {
            await config.update('gitlabMcpArgs', this.setupFields.gitlabMcpArgs.split(' ').filter(Boolean), target);
          }
        }
        break;
      }
      case 'jira': {
        const conn = this.setupFields.jiraConnectionType || 'stdio';
        await config.update('connectionType', conn, target);
        if (conn === 'stdio') {
          if (this.setupFields.jiraStdioCommand) {
            await config.update('stdioCommand', this.setupFields.jiraStdioCommand, target);
          }
          if (this.setupFields.jiraStdioArgs) {
            await config.update('stdioArgs', this.setupFields.jiraStdioArgs.split(' ').filter(Boolean), target);
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
    }

    // Reset state
    this.setupStep = 0;
    this.setupMode = undefined;
    this.setupFields = {};
  }
}
