import * as vscode from 'vscode';
import {
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider
} from '../ai/aiProviderSetup';
import { identifyPlanFolder } from '@praxis/core';
import { toStoredFolderPath } from '@praxis/core';

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
  public static readonly viewId = 'praxis.setup';

  private view?: vscode.WebviewView;
  private setupStep: 0 | 1 = 0;
  private setupMode: string | undefined;
  private setupFields: Record<string, string> = {};
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly context: vscode.ExtensionContext) {}

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

    // When the view becomes visible again (e.g. after the user resets the
    // backend mode), reset to the mode-selection screen so they see a clean
    // starting state instead of a stale form.
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this.setupStep = 0;
          this.setupMode = undefined;
          this.setupFields = {};
          this.render();
        }
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
      .danger-zone {
        margin-top: 20px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-widget-border, transparent);
        display: flex;
        justify-content: center;
      }
      .btn-danger-link {
        flex: none;
        height: auto;
        width: auto;
        border: none;
        border-radius: 0;
        background: transparent;
        font-size: 11px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-errorForeground, #f44747);
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
        opacity: 0.8;
      }
      .btn-danger-link:hover {
        opacity: 1;
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
      { mode: 'livefolder', emoji: '📂', title: 'Live Folder', desc: 'Two-way sync with a markdown plans folder' },
      { mode: 'jiracloud', emoji: '☁️', title: 'Jira MCP', desc: 'Connect to Jira via a configured MCP server' },
      { mode: 'demo', emoji: '🎭', title: 'Demo', desc: 'Try with sample data, no configuration needed' }
    ];
    if (!vscode.workspace.workspaceFolders?.length) {
      modes.splice(2, 0, {
        mode: 'userworkspace',
        emoji: '🧰',
        title: 'Create User Workspace',
        desc: 'Store Praxis boards outside VS Code workspaces and add plan-folder boards later.'
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
      case 'livefolder':
        fields = this.renderLiveFolderFields();
        break;
      case 'userworkspace':
        fields = this.renderUserWorkspaceFields();
        break;
      case 'jiracloud':
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

  private renderLiveFolderFields(): string {
    const folderPath = escapeHtml(this.setupFields.liveFolderPath ?? '');
    const projectKey = escapeHtml(this.setupFields.liveFolderProjectKey ?? '');
    const projectName = escapeHtml(this.setupFields.liveFolderProjectName ?? '');
    return `<div class="form-group">
  <label>Plans Folder Path</label>
  <input type="text" data-field="liveFolderPath" value="${folderPath}" placeholder="e.g. C:\\project or C:\\project\\plans" />
  <button class="btn-browse" data-action="browse">Browse\u2026</button>
  <div class="help-text">Select a plans folder or a parent folder. Praxis will search for features/feature-NN-*/feature.md.</div>
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
    return `<p class="info-text">Create a user-scoped Praxis workspace outside the current VS Code workspace. After saving, use <strong>Create Board</strong> to add boards that point at markdown plans folders.</p>`;
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
      <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="stdio"${stdioChecked} /> Jira via stdio</label>
      <label><input type="radio" name="jiraConnectionType" data-field="jiraConnectionType" value="http"${httpChecked} /> Jira via HTTP</label>
  </div>
</div>
<div class="info-text">Connects to the MCP-provided Jira server. The MCP server itself owns authentication, polling, and refresh cadence; configure those in your MCP servers file.</div>
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
          if (mode === 'jiracloud') {
            const config = vscode.workspace.getConfiguration('praxis');
            this.setupFields.jiraMcpSiteUrl = config.get<string>('jiraMcpSiteUrl', '');
            this.setupFields.jiraMcpEpicKey = config.get<string>('jiraMcpEpicKey', '');
            this.setupFields.jiraMcpBoardJql = config.get<string>('jiraMcpBoardJql', '');
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
          if (field === 'jiraConnectionType') {
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

    const config = vscode.workspace.getConfiguration('praxis');
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
      case 'jiracloud':
        await updateSetting('jiraMcpEpicKey', (this.setupFields.jiraMcpEpicKey ?? '').trim());
        await updateSetting('jiraMcpBoardJql', (this.setupFields.jiraMcpBoardJql ?? '').trim());
        break;
    }

    const aiResult = await promptToConfigureDefaultAiProvider();
    void vscode.window.showInformationMessage(
      `${
        savedMode === 'livefolder'
          ? 'Live Folder'
          : savedMode === 'userworkspace'
            ? 'User Workspace'
            : savedMode.toUpperCase()
      } configuration saved.${savedMode === 'userworkspace' ? ' Use Create Board to add a plans folder board.' : ''} ${describeAiConfigurationResult(aiResult)}`
    );

    // Don't reset state or re-render here.  The onDidChangeConfiguration
    // handler sets praxis.configured = true, which hides this sidebar
    // via the when-clause.  If the view later becomes visible again (e.g. on
    // mode reset), the onDidChangeVisibility handler resets to step 0.
  }

  private async resolveLiveFolderPath(
    folderPath: string | vscode.Uri
  ): Promise<{ resolvedPath: string; changed: boolean }> {
    const originalPath = typeof folderPath === 'string' ? folderPath.trim() : folderPath.fsPath;
    if (!originalPath) {
      throw new Error('Plans folder path is required for Live Folder mode.');
    }

    const identified = await identifyPlanFolder(originalPath);
    const resolvedPath = toStoredFolderPath(identified.plansRootPath);
    return {
      resolvedPath,
      changed: resolvedPath !== toStoredFolderPath(originalPath)
    };
  }

  }
