import * as vscode from 'vscode';
import {
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider
} from '../ai/aiProviderSetup';
import { identifyPlanFolder } from '../livefolder/markdownPlanParser';
import { toStoredFolderPath } from '../livefolder/pathUtils';

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

  /** Reset the setup sidebar back to the mode-selection screen and re-render. */
  public resetToModeSelection(): void {
    this.setupStep = 0;
    this.setupMode = undefined;
    this.setupFields = {};
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
      .settings-section {
        margin: 16px 0;
        padding: 12px;
        border: 1px solid var(--vscode-widget-border, transparent);
        border-radius: 6px;
        background: var(--vscode-editorWidget-background, transparent);
      }
      .toggle-switch {
        position: relative;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr);
        align-items: center;
        column-gap: 10px;
        width: 100%;
        cursor: pointer;
        user-select: none;
      }
      .toggle-switch input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
      }
      .toggle-slider {
        position: relative;
        width: 40px;
        height: 22px;
        flex: 0 0 40px;
        border-radius: 999px;
        background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.35));
        transition: background 0.15s ease;
      }
      .toggle-label {
        min-width: 0;
        margin-bottom: 0;
        line-height: 1.35;
        white-space: normal;
      }
      .toggle-slider::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--vscode-input-foreground, #fff);
        transition: transform 0.15s ease;
      }
      .toggle-switch input:checked + .toggle-slider {
        background: var(--vscode-button-background);
      }
      .toggle-switch input:checked + .toggle-slider::after {
        transform: translateX(18px);
      }
      .toggle-switch input:focus-visible + .toggle-slider {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: 2px;
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
          const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
          vscodeApi.postMessage({ type: 'updateField', field: e.target.dataset.field, value });
        }
      });

      document.addEventListener('change', e => {
        if (e.target.dataset.field) {
          const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
          vscodeApi.postMessage({ type: 'updateField', field: e.target.dataset.field, value });
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
      { mode: 'jira', emoji: '🔗', title: 'Jira via MCP', desc: 'Connect to Jira through an MCP server' },
      { mode: 'jiraapi', emoji: '📡', title: 'Jira API', desc: 'Connect directly to Jira Server/Data Center' },
      { mode: 'demo', emoji: '🎭', title: 'Demo', desc: 'Try with sample data, no configuration needed' }
    ];
    if (!vscode.workspace.workspaceFolders?.length) {
      modes.splice(2, 0, {
        mode: 'userworkspace',
        emoji: '🧰',
        title: 'Create User Workspace',
        desc: 'Store Ticket Manager boards outside VS Code workspaces and add plan-folder boards later.'
      });
    }

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
      case 'userworkspace':
        fields = this.renderUserWorkspaceFields();
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
      case 'jiraapi':
        fields = this.renderJiraApiFields();
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
  <input type="text" data-field="liveFolderPath" value="${folderPath}" placeholder="e.g. C:\\project or C:\\project\\plans" />
  <button class="btn-browse" data-action="browse">Browse\u2026</button>
  <div class="help-text">Select a plans folder or a parent folder. Ticket Manager will search for features/feature-NN-*/feature.md.</div>
</div>
<div class="form-group">
  <label>Project Key</label>
  <input type="text" data-field="liveFolderProjectKey" value="${projectKey}" placeholder="e.g. TRAKA" />
</div>
<div class="form-group">
  <label>Project Name</label>
  <input type="text" data-field="liveFolderProjectName" value="${projectName}" placeholder="e.g. TrakaHIS Integration" />
</div>`;
  }

  private renderUserWorkspaceFields(): string {
    return `<p class="info-text">Create a user-scoped Ticket Manager workspace outside the current VS Code workspace. After saving, use <strong>Create Board</strong> to add boards that point at markdown plans folders.</p>`;
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
    const pollingLabel = escapeHtml((this.setupFields.jiraPollingRequiredLabel ?? 'syscfg').toString());
    const pollingEnabled = (this.setupFields.jiraPollingEnabled ?? 'true') !== 'false';

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
    <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="stdio"${stdioChecked} /> Jira MCP via stdio</label>
    <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="http"${httpChecked} /> Jira MCP via HTTP</label>
  </div>
</div>
<div class="settings-section">
  <label>JIRA polling</label>
  <div class="info-text">Polls the Jira API every 30 seconds to get tickets with the specified label.</div>
  <div class="form-group">
    <label>Label</label>
    <input type="text" data-field="jiraPollingRequiredLabel" value="${pollingLabel}" placeholder="syscfg" />
  </div>
  <div class="form-group">
    <label class="toggle-switch">
      <input type="checkbox" data-field="jiraPollingEnabled" ${pollingEnabled ? 'checked' : ''} />
      <span class="toggle-slider" aria-hidden="true"></span>
      <span class="toggle-label">Enable JIRA polling</span>
    </label>
  </div>
</div>
${connFields}`;
  }

  private renderJiraApiFields(): string {
    const baseUrl = escapeHtml(this.setupFields.jiraApiBaseUrl ?? '');
    const token = escapeHtml(this.setupFields.jiraApiToken ?? '');
    const epicKey = escapeHtml(this.setupFields.jiraApiEpicKey ?? '');
    const pollingLabel = escapeHtml((this.setupFields.jiraPollingRequiredLabel ?? 'syscfg').toString());
    const pollingEnabled = (this.setupFields.jiraPollingEnabled ?? 'true') !== 'false';

    return `<div class="form-group">
  <label>Jira Base URL</label>
  <input type="text" data-field="jiraApiBaseUrl" value="${baseUrl}" placeholder="Defaults to the polling service Jira base URL" />
</div>
<div class="form-group">
  <label>Personal Access Token</label>
  <input type="password" data-field="jiraApiToken" value="${token}" placeholder="Leave blank to use JIRA_TOKEN" />
</div>
<div class="form-group">
  <label>Linked Epic Key</label>
  <input type="text" data-field="jiraApiEpicKey" value="${epicKey}" placeholder="Optional: e.g. KAMAI-123" />
  <div class="help-text">Workspace-level epic associated with this repo. Boards and polling sync follow this epic, and Jira API issue creation uses it as the default parent.</div>
</div>
<div class="settings-section">
  <label>AI execution gate</label>
  <div class="info-text">The poller syncs all tasks linked to the epic. Only linked-epic tasks with this label and the configured todo-stage status are eligible for AI execution.</div>
  <div class="form-group">
    <label>Label</label>
    <input type="text" data-field="jiraPollingRequiredLabel" value="${pollingLabel}" placeholder="syscfg" />
  </div>
  <div class="form-group">
    <label class="toggle-switch">
      <input type="checkbox" data-field="jiraPollingEnabled" ${pollingEnabled ? 'checked' : ''} />
      <span class="toggle-slider" aria-hidden="true"></span>
      <span class="toggle-label">Enable JIRA polling</span>
    </label>
  </div>
</div>`;
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
          if (mode === 'jira' || mode === 'jiraapi') {
            const config = vscode.workspace.getConfiguration('ticketManager');
            this.setupFields.jiraPollingRequiredLabel = config.get<string>('jiraPolling.requiredLabel', 'syscfg').trim() || 'syscfg';
            this.setupFields.jiraPollingEnabled = String(config.get<boolean>('jiraPolling.enabled', true));
            if (mode === 'jira' && !this.setupFields.jiraConnectionType) {
              this.setupFields.jiraConnectionType = 'stdio';
            }
            if (mode === 'jiraapi') {
              this.setupFields.jiraApiBaseUrl = config.get<string>('jiraApiBaseUrl', '');
              this.setupFields.jiraApiToken = config.get<string>('jiraApiToken', '');
              this.setupFields.jiraApiEpicKey = config.get<string>('jiraApiEpicKey', '');
            }
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
        const value =
          typeof payload.value === 'boolean'
            ? String(payload.value)
            : typeof payload.value === 'string'
              ? payload.value
              : '';
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
            title: 'Select Folder to Search for Plans'
          });
          if (uris?.[0]) {
            try {
              const { resolvedPath, changed } = await this.resolveLiveFolderPath(uris[0]);
              this.setupFields.liveFolderPath = resolvedPath;
              this.render();
              if (changed) {
                void vscode.window.showInformationMessage(`Found plans folder at ${resolvedPath}.`);
              }
            } catch (error) {
              void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error)
              );
            }
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
        try {
          await this.saveSetupConfiguration();
        } catch (error) {
          void vscode.window.showErrorMessage(`Failed to save configuration: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
    }
  }

  private async saveSetupConfiguration(): Promise<void> {
    if (!this.setupMode) {
      return;
    }

    const savedMode = this.setupMode;

    const config = vscode.workspace.getConfiguration('ticketManager');
    const target =
      this.setupMode === 'userworkspace'
        ? vscode.ConfigurationTarget.Global
        : vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

    const updateSetting = async (key: string, value: unknown): Promise<void> => {
      await config.update(key, value, target);
    };

    if (this.setupMode === 'livefolder') {
      const { resolvedPath } = await this.resolveLiveFolderPath(this.setupFields.liveFolderPath ?? '');
      this.setupFields.liveFolderPath = resolvedPath;
    }

    await updateSetting('backendMode', this.setupMode);

    switch (this.setupMode) {
      case 'file':
        if (this.setupFields.planFilePath) {
          await updateSetting('planFilePath', this.setupFields.planFilePath);
        }
        break;
      case 'livefolder':
        await updateSetting('liveFolderPath', this.setupFields.liveFolderPath);
        if (this.setupFields.liveFolderProjectKey) {
          await updateSetting('liveFolderProjectKey', this.setupFields.liveFolderProjectKey);
        }
        if (this.setupFields.liveFolderProjectName) {
          await updateSetting('liveFolderProjectName', this.setupFields.liveFolderProjectName);
        }
        break;
      case 'userworkspace':
        break;
      case 'github':
        if (this.setupFields.githubUrl) {
          await updateSetting('githubUrl', this.setupFields.githubUrl);
        }
        if (this.setupFields.githubPat) {
          await updateSetting('githubPat', this.setupFields.githubPat);
        }
        if (this.setupFields.githubOwner) {
          await updateSetting('githubOwner', this.setupFields.githubOwner);
        }
        break;
      case 'gitlab': {
        if (this.setupFields.gitlabUrl) {
          await updateSetting('gitlabUrl', this.setupFields.gitlabUrl);
        }
        const glConn = this.setupFields.gitlabConnectionType || 'api';
        await updateSetting('gitlabConnectionType', glConn);
        if (glConn === 'api' && this.setupFields.gitlabApiKey) {
          await updateSetting('gitlabApiKey', this.setupFields.gitlabApiKey);
        } else if (glConn === 'mcp') {
          if (this.setupFields.gitlabMcpCommand) {
            await updateSetting('gitlabMcpCommand', this.setupFields.gitlabMcpCommand);
          }
          if (this.setupFields.gitlabMcpArgs) {
            await updateSetting('gitlabMcpArgs', this.setupFields.gitlabMcpArgs.split(' ').filter(Boolean));
          }
        }
        break;
      }
      case 'jira': {
        const conn = this.setupFields.jiraConnectionType || 'stdio';
        await updateSetting('connectionType', conn);
        await updateSetting(
          'jiraPolling.requiredLabel',
          (this.setupFields.jiraPollingRequiredLabel ?? '').trim() || 'syscfg'
        );
        await updateSetting(
          'jiraPolling.enabled',
          (this.setupFields.jiraPollingEnabled ?? 'true') !== 'false'
        );
        if (conn === 'stdio') {
          if (this.setupFields.jiraStdioCommand) {
            await updateSetting('stdioCommand', this.setupFields.jiraStdioCommand);
          }
          if (this.setupFields.jiraStdioArgs) {
            await updateSetting('stdioArgs', this.setupFields.jiraStdioArgs.split(' ').filter(Boolean));
          }
          if (this.setupFields.jiraCwd) {
            await updateSetting('stdioCwd', this.setupFields.jiraCwd);
          }
        } else {
          if (this.setupFields.jiraHttpUrl) {
            await updateSetting('httpUrl', this.setupFields.jiraHttpUrl);
          }
        }
        break;
      }
      case 'jiraapi':
        await updateSetting('jiraApiBaseUrl', (this.setupFields.jiraApiBaseUrl ?? '').trim());
        await updateSetting('jiraApiToken', (this.setupFields.jiraApiToken ?? '').trim());
        await updateSetting('jiraApiEpicKey', (this.setupFields.jiraApiEpicKey ?? '').trim());
        await updateSetting(
          'jiraPolling.requiredLabel',
          (this.setupFields.jiraPollingRequiredLabel ?? '').trim() || 'syscfg'
        );
        await updateSetting(
          'jiraPolling.enabled',
          (this.setupFields.jiraPollingEnabled ?? 'true') !== 'false'
        );
        break;
    }

    const aiResult = await promptToConfigureDefaultAiProvider();
    void vscode.window.showInformationMessage(
      `${
        savedMode === 'livefolder'
          ? 'Live Folder'
          : savedMode === 'userworkspace'
            ? 'User Workspace'
          : savedMode === 'file'
            ? 'File'
            : savedMode.toUpperCase()
      } configuration saved.${savedMode === 'userworkspace' ? ' Use Create Board to add a plans folder board.' : ''} ${describeAiConfigurationResult(aiResult)}`
    );

    // Reset state and re-render to show mode selection
    this.setupStep = 0;
    this.setupMode = undefined;
    this.setupFields = {};
    this.render();
  }

  private async resolveLiveFolderPath(
    folderPath: string | vscode.Uri
  ): Promise<{ resolvedPath: string; changed: boolean }> {
    const originalPath = typeof folderPath === 'string' ? folderPath.trim() : folderPath.fsPath;
    if (!originalPath) {
      throw new Error('Plans folder path is required for Live Folder mode.');
    }

    const identified = await identifyPlanFolder(folderPath);
    const resolvedPath = toStoredFolderPath(identified.plansRootUri.fsPath);
    return {
      resolvedPath,
      changed: resolvedPath !== toStoredFolderPath(originalPath)
    };
  }
}
