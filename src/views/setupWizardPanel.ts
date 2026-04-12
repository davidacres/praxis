import * as vscode from 'vscode';
import {
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider
} from '../ai/aiProviderSetup';
import { identifyPlanFolder } from '../livefolder/markdownPlanParser';
import { toStoredFolderPath } from '../livefolder/pathUtils';
import type { BackendMode } from '../types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Extended backend mode that includes all wizard options.
 * When `BackendMode` in types.ts is updated to include 'github' | 'gitlab',
 * this alias can be replaced with the canonical type.
 */
type SetupBackendMode = BackendMode | 'github' | 'gitlab';

interface SetupState {
  step: 0 | 1;
  selectedMode: SetupBackendMode | undefined;
  // Plan File
  planFilePath: string;
  // Live Folder
  liveFolderPath: string;
  liveFolderProjectKey: string;
  liveFolderProjectName: string;
  // GitHub
  githubUrl: string;
  githubPat: string;
  githubOwner: string;
  // GitLab
  gitlabUrl: string;
  gitlabConnectionType: 'api' | 'mcp';
  gitlabApiKey: string;
  gitlabMcpCommand: string;
  gitlabMcpArgs: string;
  // Jira
  jiraConnectionType: 'stdio' | 'http';
  jiraStdioCommand: string;
  jiraStdioArgs: string;
  jiraCwd: string;
  jiraHttpUrl: string;
}

function createInitialState(): SetupState {
  return {
    step: 0,
    selectedMode: undefined,
    planFilePath: '',
    liveFolderPath: '',
    liveFolderProjectKey: '',
    liveFolderProjectName: '',
    githubUrl: 'https://api.github.com',
    githubPat: '',
    githubOwner: '',
    gitlabUrl: '',
    gitlabConnectionType: 'api',
    gitlabApiKey: '',
    gitlabMcpCommand: '',
    gitlabMcpArgs: '',
    jiraConnectionType: 'stdio',
    jiraStdioCommand: '',
    jiraStdioArgs: '',
    jiraCwd: '',
    jiraHttpUrl: '',
  };
}

/* ------------------------------------------------------------------ */
/*  Mode metadata                                                     */
/* ------------------------------------------------------------------ */

interface ModeOption {
  mode: SetupBackendMode;
  icon: string;
  title: string;
  description: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { mode: 'file', icon: '🗂️', title: 'Plan File', description: 'Manage tickets from a local JSON plan file' },
  { mode: 'livefolder', icon: '📂', title: 'Live Folder', description: 'Two-way sync with a markdown plans folder' },
  { mode: 'github', icon: '🐙', title: 'GitHub', description: 'Connect to GitHub repositories and issues' },
  { mode: 'gitlab', icon: '🦊', title: 'GitLab', description: 'Connect to a GitLab instance for issues and boards' },
  { mode: 'jira', icon: '🔗', title: 'Jira', description: 'Connect to Jira via MCP server' },
  { mode: 'demo', icon: '🎭', title: 'Demo', description: 'Try with sample data, no configuration needed' },
];

function getModeOptions(): ModeOption[] {
  if (vscode.workspace.workspaceFolders?.length) {
    return MODE_OPTIONS;
  }
  return [
    MODE_OPTIONS[0],
    MODE_OPTIONS[1],
    {
      mode: 'userworkspace',
      icon: '🧰',
      title: 'Create User Workspace',
      description: 'Store Ticket Manager boards outside VS Code workspaces and add plan-folder boards later'
    },
    ...MODE_OPTIONS.slice(2)
  ];
}

/* ------------------------------------------------------------------ */
/*  Panel                                                             */
/* ------------------------------------------------------------------ */

export class SetupWizardPanel {
  private panel: vscode.WebviewPanel | undefined;
  private state: SetupState;
  private onComplete: ((mode: SetupBackendMode | undefined) => void) | undefined;

  constructor() {
    this.state = createInitialState();
  }

  /**
   * Open the panel; returns a promise that resolves with the chosen mode
   * when the user saves, or `undefined` if the panel is closed without saving.
   */
  public open(): Promise<SetupBackendMode | undefined> {
    return new Promise(resolve => {
      this.onComplete = resolve;
      this.state = createInitialState();

      if (this.panel) {
        this.panel.reveal();
        this.rerender();
        return;
      }

      this.panel = vscode.window.createWebviewPanel(
        'ticketManager.setupWizard',
        'Configure Project',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.onComplete?.(undefined);
        this.onComplete = undefined;
      });

      this.panel.webview.onDidReceiveMessage(
        msg => { void this.handleMessage(msg); },
        undefined,
        []
      );

      this.panel.webview.html = this.getHtml();
    });
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  /* ---------------------------------------------------------------- */
  /*  Message handling                                                */
  /* ---------------------------------------------------------------- */

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const command = typeof message.command === 'string' ? message.command : '';

    switch (command) {
      case 'selectMode': {
        const mode = typeof message.mode === 'string' ? message.mode as SetupBackendMode : undefined;
        if (mode) {
          this.state.selectedMode = mode;
          this.state.step = 1;
          this.rerender();
        }
        break;
      }

      case 'back':
        this.state.step = 0;
        this.rerender();
        break;

      case 'updateField': {
        const field = typeof message.field === 'string' ? message.field : '';
        const value = typeof message.value === 'string' ? message.value : '';
        if (field && field in this.state) {
          (this.state as unknown as Record<string, unknown>)[field] = value;
          this.rerender();
        }
        break;
      }

      case 'browse': {
        if (this.state.selectedMode === 'livefolder') {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Select Folder to Search for Plans',
          });
          if (uris && uris.length > 0) {
            try {
              const { resolvedPath, changed } = await this.resolveLiveFolderPath(uris[0]);
              this.state.liveFolderPath = resolvedPath;
              this.rerender();
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
            canSelectMany: false,
            filters: { 'JSON files': ['json'], 'All files': ['*'] },
            openLabel: 'Select Plan File',
          });
          if (uris && uris.length > 0) {
            this.state.planFilePath = uris[0].fsPath;
            this.rerender();
          }
        }
        break;
      }

      case 'save':
        try {
          await this.saveConfiguration();
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Failed to save configuration: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Save configuration                                              */
  /* ---------------------------------------------------------------- */

  private async saveConfiguration(): Promise<void> {
    if (!this.state.selectedMode) {
      return;
    }

    const savedMode = this.state.selectedMode;

    const config = vscode.workspace.getConfiguration('ticketManager');
    const target = this.state.selectedMode === 'userworkspace'
      ? vscode.ConfigurationTarget.Global
      : vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    if (this.state.selectedMode === 'livefolder') {
      const { resolvedPath } = await this.resolveLiveFolderPath(this.state.liveFolderPath);
      this.state.liveFolderPath = resolvedPath;
    }

    await config.update('backendMode', this.state.selectedMode, target);

    switch (this.state.selectedMode) {
      case 'file':
        await config.update('planFilePath', this.state.planFilePath, target);
        break;

      case 'livefolder':
        await config.update('liveFolderPath', this.state.liveFolderPath, target);
        await config.update('liveFolderProjectKey', this.state.liveFolderProjectKey, target);
        await config.update('liveFolderProjectName', this.state.liveFolderProjectName, target);
        break;

      case 'userworkspace':
        break;

      case 'github':
        await config.update('githubUrl', this.state.githubUrl, target);
        await config.update('githubPat', this.state.githubPat, target);
        await config.update('githubOwner', this.state.githubOwner, target);
        break;

      case 'gitlab':
        await config.update('gitlabUrl', this.state.gitlabUrl, target);
        await config.update('gitlabConnectionType', this.state.gitlabConnectionType, target);
        if (this.state.gitlabConnectionType === 'api') {
          await config.update('gitlabApiKey', this.state.gitlabApiKey, target);
        } else {
          await config.update('gitlabMcpCommand', this.state.gitlabMcpCommand, target);
          await config.update('gitlabMcpArgs', this.state.gitlabMcpArgs.split(' ').filter(Boolean), target);
        }
        break;

      case 'jira':
        await config.update('connectionType', this.state.jiraConnectionType, target);
        if (this.state.jiraConnectionType === 'stdio') {
          await config.update('stdioCommand', this.state.jiraStdioCommand, target);
          await config.update('stdioArgs', this.state.jiraStdioArgs.split(' ').filter(Boolean), target);
          await config.update('stdioCwd', this.state.jiraCwd, target);
        } else {
          await config.update('httpUrl', this.state.jiraHttpUrl, target);
        }
        break;

      // demo needs no config
    }

    this.onComplete?.(savedMode);
    this.onComplete = undefined;
    this.panel?.dispose();

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
  }

  /* ---------------------------------------------------------------- */
  /*  Re-render                                                       */
  /* ---------------------------------------------------------------- */

  private rerender(): void {
    if (this.panel) {
      this.panel.webview.html = this.getHtml();
    }
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

  /* ---------------------------------------------------------------- */
  /*  HTML generation                                                 */
  /* ---------------------------------------------------------------- */

  private getHtml(): string {
    const nonce = createNonce();
    const bodyContent = this.state.step === 0
      ? this.renderStep0()
      : this.renderStep1();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>${SetupWizardPanel.getCss()}</style>
</head>
<body>
  <div class="wizard-container">
    <h1 class="wizard-title">Configure Project</h1>
    ${bodyContent}
  </div>
  <script nonce="${nonce}">
    ${SetupWizardPanel.getScript()}
  </script>
</body>
</html>`;
  }

  /* ---------------------------------------------------------------- */
  /*  Step 0 – Choose project type                                    */
  /* ---------------------------------------------------------------- */

  private renderStep0(): string {
    const cards = getModeOptions().map(opt => `
      <div class="mode-card" data-action="selectMode" data-mode="${esc(opt.mode)}">
        <span class="mode-icon">${opt.icon}</span>
        <span class="mode-title">${esc(opt.title)}</span>
        <span class="mode-desc">${esc(opt.description)}</span>
      </div>`).join('');

    return `
      <p class="step-description">Choose how you want to manage your project tickets.</p>
      <div class="card-grid">${cards}</div>`;
  }

  /* ---------------------------------------------------------------- */
  /*  Step 1 – Configure selected mode                                */
  /* ---------------------------------------------------------------- */

  private renderStep1(): string {
    const mode = this.state.selectedMode;
    const opt = MODE_OPTIONS.find(o => o.mode === mode);
    const header = opt
      ? `<h2 class="step-header">${opt.icon} ${esc(opt.title)}</h2>`
      : '';

    let formHtml = '';
    switch (mode) {
      case 'file':
        formHtml = this.renderFileForm();
        break;
      case 'livefolder':
        formHtml = this.renderLiveFolderForm();
        break;
      case 'userworkspace':
        formHtml = this.renderUserWorkspaceForm();
        break;
      case 'github':
        formHtml = this.renderGithubForm();
        break;
      case 'gitlab':
        formHtml = this.renderGitlabForm();
        break;
      case 'jira':
        formHtml = this.renderJiraForm();
        break;
      case 'demo':
        formHtml = this.renderDemoForm();
        break;
      default:
        formHtml = '<p>Unknown mode.</p>';
    }

    return `
      ${header}
      ${formHtml}
      <div class="button-row">
        <button class="btn btn-secondary" data-action="back">← Back</button>
        <button class="btn btn-primary" data-action="save">Save &amp; Connect</button>
      </div>`;
  }

  /* -- File form --------------------------------------------------- */

  private renderFileForm(): string {
    return `
      <p class="form-help">Enter the path to your ticket plan JSON file, or browse to select one.</p>
      <div class="field-group">
        <label class="field-label">File Path</label>
        <div class="input-row">
          <input type="text" class="field-input input-flex"
                 data-field="planFilePath"
                 value="${esc(this.state.planFilePath)}"
                 placeholder="/path/to/plan.json" />
          <button class="btn btn-secondary" data-action="browse">Browse…</button>
        </div>
      </div>`;
  }

  /* -- Live Folder form -------------------------------------------- */

  private renderLiveFolderForm(): string {
    return `
      <p class="form-help">Select a plans folder or a parent folder. Ticket Manager will search for features/feature-NN-*/feature.md and story-*.md files.</p>
      <div class="field-group">
        <label class="field-label">Plans Folder Path</label>
        <div class="input-row">
          <input type="text" class="field-input input-flex"
                 data-field="liveFolderPath"
                 value="${esc(this.state.liveFolderPath)}"
                 placeholder="C:\\project or C:\\project\\plans" />
          <button class="btn btn-secondary" data-action="browse">Browse…</button>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">Project Key</label>
        <input type="text" class="field-input"
               data-field="liveFolderProjectKey"
               value="${esc(this.state.liveFolderProjectKey)}"
               placeholder="e.g. EXAMPLE" />
      </div>
      <div class="field-group">
        <label class="field-label">Project Name</label>
        <input type="text" class="field-input"
               data-field="liveFolderProjectName"
               value="${esc(this.state.liveFolderProjectName)}"
               placeholder="e.g. ExampleHIS Integration" />
      </div>`;
  }

  private renderUserWorkspaceForm(): string {
    return `
      <p class="form-help">Create a user-scoped Ticket Manager workspace outside the current VS Code workspace. After saving, use <strong>Create Board</strong> to add boards that point at markdown plans folders.</p>`;
  }

  /* -- GitHub form ------------------------------------------------- */

  private renderGithubForm(): string {
    return `
      <div class="field-group">
        <label class="field-label">GitHub API URL</label>
        <input type="text" class="field-input"
               data-field="githubUrl"
               value="${esc(this.state.githubUrl)}"
               placeholder="https://api.github.com" />
      </div>
      <div class="field-group">
        <label class="field-label">Personal Access Token</label>
        <input type="password" class="field-input"
               data-field="githubPat"
               value="${esc(this.state.githubPat)}"
               placeholder="ghp_…" />
        <p class="field-hint">Need a token?
          <a href="https://github.com/settings/tokens" class="link">Create one on GitHub</a>
        </p>
      </div>
      <div class="field-group">
        <label class="field-label">Owner / Organization</label>
        <input type="text" class="field-input"
               data-field="githubOwner"
               value="${esc(this.state.githubOwner)}"
               placeholder="my-org" />
      </div>`;
  }

  /* -- GitLab form ------------------------------------------------- */

  private renderGitlabForm(): string {
    const isApi = this.state.gitlabConnectionType === 'api';
    const isMcp = this.state.gitlabConnectionType === 'mcp';

    const apiFields = isApi ? `
      <div class="field-group">
        <label class="field-label">API Key</label>
        <input type="password" class="field-input"
               data-field="gitlabApiKey"
               value="${esc(this.state.gitlabApiKey)}"
               placeholder="glpat-…" />
        <p class="field-hint">Need a token? Create one in GitLab → Settings → Access Tokens</p>
      </div>` : '';

    const mcpFields = isMcp ? `
      <div class="field-group">
        <label class="field-label">MCP Command</label>
        <input type="text" class="field-input"
               data-field="gitlabMcpCommand"
               value="${esc(this.state.gitlabMcpCommand)}"
               placeholder="npx gitlab-mcp-server" />
      </div>
      <div class="field-group">
        <label class="field-label">MCP Args</label>
        <input type="text" class="field-input"
               data-field="gitlabMcpArgs"
               value="${esc(this.state.gitlabMcpArgs)}"
               placeholder="--token XXX" />
      </div>` : '';

    return `
      <div class="field-group">
        <label class="field-label">GitLab URL</label>
        <input type="text" class="field-input"
               data-field="gitlabUrl"
               value="${esc(this.state.gitlabUrl)}"
               placeholder="https://gitlab.com" />
      </div>
      <div class="field-group">
        <label class="field-label">Connection Type</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" name="gitlabConnectionType"
                   data-field="gitlabConnectionType"
                   value="api" ${isApi ? 'checked' : ''} />
            API Key
          </label>
          <label class="radio-label">
            <input type="radio" name="gitlabConnectionType"
                   data-field="gitlabConnectionType"
                   value="mcp" ${isMcp ? 'checked' : ''} />
            GitLab MCP Server
          </label>
        </div>
      </div>
      ${apiFields}
      ${mcpFields}`;
  }

  /* -- Jira form --------------------------------------------------- */

  private renderJiraForm(): string {
    const isStdio = this.state.jiraConnectionType === 'stdio';
    const isHttp = this.state.jiraConnectionType === 'http';

    const stdioFields = isStdio ? `
      <div class="field-group">
        <label class="field-label">Command</label>
        <input type="text" class="field-input"
               data-field="jiraStdioCommand"
               value="${esc(this.state.jiraStdioCommand)}"
               placeholder="npx jira-mcp-server" />
      </div>
      <div class="field-group">
        <label class="field-label">Args</label>
        <input type="text" class="field-input"
               data-field="jiraStdioArgs"
               value="${esc(this.state.jiraStdioArgs)}"
               placeholder="--host jira.example.com" />
      </div>
      <div class="field-group">
        <label class="field-label">Working Directory</label>
        <input type="text" class="field-input"
               data-field="jiraCwd"
               value="${esc(this.state.jiraCwd)}"
               placeholder="/path/to/server" />
      </div>` : '';

    const httpFields = isHttp ? `
      <div class="field-group">
        <label class="field-label">URL</label>
        <input type="text" class="field-input"
               data-field="jiraHttpUrl"
               value="${esc(this.state.jiraHttpUrl)}"
               placeholder="http://localhost:3000" />
      </div>` : '';

    return `
      <p class="form-help">Jira uses an MCP server. Configure the connection to your Jira MCP server.</p>
      <div class="field-group">
        <label class="field-label">Connection Type</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" name="jiraConnectionType"
                   data-field="jiraConnectionType"
                   value="stdio" ${isStdio ? 'checked' : ''} />
            Local MCP (stdio)
          </label>
          <label class="radio-label">
            <input type="radio" name="jiraConnectionType"
                   data-field="jiraConnectionType"
                   value="http" ${isHttp ? 'checked' : ''} />
            Remote MCP (HTTP)
          </label>
        </div>
      </div>
      ${stdioFields}
      ${httpFields}`;
  }

  /* -- Demo form --------------------------------------------------- */

  private renderDemoForm(): string {
    return `
      <p class="form-help">
        Demo mode uses sample data — no configuration needed. Click <strong>Save &amp; Connect</strong> to get started!
      </p>`;
  }

  /* ---------------------------------------------------------------- */
  /*  CSS (static)                                                    */
  /* ---------------------------------------------------------------- */

  private static getCss(): string {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        line-height: 1.5;
        padding: 24px 16px;
      }

      .wizard-container {
        max-width: 700px;
        margin: 0 auto;
      }

      .wizard-title {
        font-size: 1.6em;
        font-weight: 600;
        margin-bottom: 8px;
      }

      .step-description {
        color: var(--vscode-descriptionForeground);
        margin-bottom: 20px;
      }

      /* ---- Cards ---- */

      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px;
      }

      .mode-card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 16px;
        border-radius: 6px;
        border: 1px solid var(--vscode-editorWidget-border);
        background: var(--vscode-editorWidget-background);
        cursor: pointer;
        transition: background 0.15s;
      }

      .mode-card:hover {
        background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
      }

      .mode-card:focus-visible {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: -2px;
      }

      .mode-icon {
        font-size: 28px;
        line-height: 1;
        margin-bottom: 4px;
      }

      .mode-title {
        font-weight: 600;
        font-size: 1.05em;
      }

      .mode-desc {
        color: var(--vscode-descriptionForeground);
        font-size: 0.92em;
      }

      /* ---- Step 1 ---- */

      .step-header {
        font-size: 1.3em;
        font-weight: 600;
        margin-bottom: 16px;
      }

      .form-help {
        color: var(--vscode-descriptionForeground);
        margin-bottom: 16px;
      }

      .field-group {
        margin-bottom: 16px;
      }

      .field-label {
        display: block;
        font-weight: 600;
        margin-bottom: 4px;
      }

      .field-input {
        width: 100%;
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-family: inherit;
        font-size: inherit;
        outline: none;
      }

      .field-input:focus {
        border-color: var(--vscode-focusBorder);
      }

      .input-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .input-flex {
        flex: 1;
      }

      .field-hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.88em;
        margin-top: 4px;
      }

      .link {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
      }

      .link:hover {
        text-decoration: underline;
      }

      /* ---- Radios ---- */

      .radio-group {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }

      .radio-label {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }

      /* ---- Buttons ---- */

      .button-row {
        display: flex;
        gap: 10px;
        margin-top: 24px;
      }

      .btn {
        padding: 6px 16px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        font-family: inherit;
        font-size: inherit;
        line-height: 1.4;
      }

      .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .btn-primary:hover {
        background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      }

      .btn-secondary {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
        border: 1px solid var(--vscode-input-border);
      }

      .btn-secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.06));
      }

      .btn:focus-visible {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Script (static — event delegation only)                         */
  /* ---------------------------------------------------------------- */

  private static getScript(): string {
    return `
      const vscode = acquireVsCodeApi();

      document.addEventListener('click', e => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;

        if (action === 'selectMode') {
          vscode.postMessage({ command: 'selectMode', mode: target.dataset.mode });
        } else if (action === 'back') {
          vscode.postMessage({ command: 'back' });
        } else if (action === 'save') {
          vscode.postMessage({ command: 'save' });
        } else if (action === 'browse') {
          vscode.postMessage({ command: 'browse' });
        }
      });

      document.addEventListener('input', e => {
        const target = e.target;
        if (target.dataset && target.dataset.field) {
          vscode.postMessage({ command: 'updateField', field: target.dataset.field, value: target.value });
        }
      });

      document.addEventListener('change', e => {
        const target = e.target;
        if (target.dataset && target.dataset.field) {
          vscode.postMessage({ command: 'updateField', field: target.dataset.field, value: target.value });
        }
      });
    `;
  }
}
