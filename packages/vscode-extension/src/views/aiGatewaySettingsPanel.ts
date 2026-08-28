import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';
import { AI_PROVIDER_LABELS } from '../ai/aiProviderSetup';
import {
  DEFAULT_VERCEL_URL,
  fetchModels,
  probeApiKeyAuth,
  resolveGatewayUrlFromEnv
} from '@ticket-manager/core';

interface PanelSnapshot {
  gatewayUrl: string;
  hasApiKey: boolean;
  agentName: string;
  statusMessage?: string;
  statusKind?: 'ok' | 'error' | 'info';
}

/**
 * Frosty-style settings page for Vercel AI Gateway URL + API key.
 * API key is stored in SecretStorage; URL/agent name live in settings.
 */
export class AiGatewaySettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly onSaved?: () => void
  ) {}

  public async open(): Promise<void> {
    await this.configStore.refreshVercelApiKeyCache();
    const snapshot = this.buildSnapshot({
      statusMessage: 'Enter your gateway URL and API key, then Test or Save.',
      statusKind: 'info'
    });

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.panel.webview.postMessage({ type: 'init', snapshot });
      return;
    }

    // Fetch/complete async work BEFORE createWebviewPanel, then set html
    // synchronously (VS Code Insiders webview rule — see CLAUDE.md).
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.aiGatewaySettings',
      'AI Gateway Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    panel.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });

    panel.webview.html = this.getHtml(snapshot);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private buildSnapshot(status?: {
    statusMessage?: string;
    statusKind?: 'ok' | 'error' | 'info';
  }): PanelSnapshot {
    const settings = this.configStore.getAiProviderSettings();
    return {
      gatewayUrl: resolveGatewayUrlFromEnv(settings.vercelUrl) || DEFAULT_VERCEL_URL,
      hasApiKey: this.configStore.hasVercelGatewayApiKeyCached(),
      agentName:
        settings.agentName.trim() || AI_PROVIDER_LABELS['vercel-gateway'],
      statusMessage: status?.statusMessage,
      statusKind: status?.statusKind
    };
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'ready') {
      await this.postInit();
      return;
    }
    if (type === 'testConnection') {
      await this.testConnection(
        asString(message.gatewayUrl),
        asString(message.apiKey)
      );
      return;
    }
    if (type === 'save') {
      await this.save(
        asString(message.gatewayUrl),
        asString(message.apiKey),
        asString(message.agentName),
        Boolean(message.clearApiKey)
      );
      return;
    }
    if (type === 'openVsCodeSettings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'ticketManager.ai'
      );
    }
  }

  private async postInit(status?: {
    statusMessage?: string;
    statusKind?: 'ok' | 'error' | 'info';
  }): Promise<void> {
    await this.configStore.refreshVercelApiKeyCache();
    await this.panel?.webview.postMessage({
      type: 'init',
      snapshot: this.buildSnapshot(status)
    });
  }

  private async resolveApiKeyForAction(apiKeyFromUi: string | undefined): Promise<string> {
    const typed = apiKeyFromUi?.trim() ?? '';
    if (typed) {
      return typed;
    }
    await this.configStore.refreshVercelApiKeyCache();
    return this.configStore.getAiVercelGatewayApiKey();
  }

  private async testConnection(
    gatewayUrl: string | undefined,
    apiKeyFromUi: string | undefined
  ): Promise<void> {
    const url = resolveGatewayUrlFromEnv(gatewayUrl) || DEFAULT_VERCEL_URL;
    const apiKey = await this.resolveApiKeyForAction(apiKeyFromUi);
    if (!apiKey) {
      await this.postInit({
        statusMessage: 'Enter an API key (or save one first) before testing.',
        statusKind: 'error'
      });
      return;
    }

    try {
      await probeApiKeyAuth({ url, apiKey });
      const models = await fetchModels({ url, apiKey });
      await this.postInit({
        statusMessage: `Connected to ${safeHost(url)} — API key accepted, ${models.length} models available.`,
        statusKind: 'ok'
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.postInit({
        statusMessage: `Connection failed: ${detail}`,
        statusKind: 'error'
      });
    }
  }

  private async save(
    gatewayUrl: string | undefined,
    apiKeyFromUi: string | undefined,
    agentName: string | undefined,
    clearApiKey: boolean
  ): Promise<void> {
    const url = (gatewayUrl?.trim() || DEFAULT_VERCEL_URL).replace(/\/$/, '');
    const settings = this.configStore.getAiProviderSettings();
    const typedKey = apiKeyFromUi?.trim() ?? '';

    try {
      if (clearApiKey) {
        await this.configStore.clearVercelGatewayApiKey();
      } else if (typedKey) {
        await this.configStore.storeVercelGatewayApiKey(typedKey);
      } else if (!this.configStore.hasVercelGatewayApiKeyCached()) {
        await this.postInit({
          statusMessage: 'Enter an API key before saving.',
          statusKind: 'error'
        });
        return;
      }

      await this.configStore.setAiProviderSettings({
        provider: 'vercel-gateway',
        credential: '',
        agentName:
          agentName?.trim() ||
          settings.agentName.trim() ||
          AI_PROVIDER_LABELS['vercel-gateway'],
        runtimePath: '',
        vercelUrl: url
      });

      await this.configStore.refreshVercelApiKeyCache();
      this.onSaved?.();
      await this.postInit({
        statusMessage: 'Saved. Vercel AI Gateway is the active AI provider.',
        statusKind: 'ok'
      });
      void vscode.window.showInformationMessage(
        'AI Gateway settings saved. Active AI: Vercel AI Gateway.'
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.postInit({
        statusMessage: `Save failed: ${detail}`,
        statusKind: 'error'
      });
    }
  }

  private getHtml(snapshot: PanelSnapshot): string {
    const nonce = getNonce();
    const initial = JSON.stringify(snapshot).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Gateway Settings</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .page {
      box-sizing: border-box;
      display: flex;
      flex: 1;
      width: 100%;
      min-height: 100vh;
      padding: 8px;
    }
    .panel-shell {
      box-sizing: border-box;
      display: flex;
      flex: 1;
      flex-direction: column;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    .header, .content { padding: 16px; }
    .header {
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .subtitle {
      margin: 0;
      opacity: 0.85;
      line-height: 1.4;
    }
    .field { margin: 0 0 14px; }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .hint {
      margin: 4px 0 0;
      opacity: 0.75;
      font-size: 0.9em;
    }
    input[type="text"], input[type="password"] {
      box-sizing: border-box;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    button {
      padding: 7px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .status {
      margin-top: 16px;
      padding: 10px 12px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
    }
    .status.ok {
      border-color: var(--vscode-testing-iconPassed, #3fb950);
    }
    .status.error {
      border-color: var(--vscode-errorForeground, #f85149);
    }
    .key-state {
      margin-top: 6px;
      font-size: 0.9em;
      opacity: 0.85;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="panel-shell">
      <div class="header">
        <h1>Vercel AI Gateway</h1>
        <p class="subtitle">
          Configure the gateway URL and API key used for reviews, analysis, and agent sessions.
          The API key is stored in VS Code Secret Storage (not settings.json).
        </p>
      </div>
      <div class="content">
        <div class="field">
          <label for="gatewayUrl">Gateway URL</label>
          <input id="gatewayUrl" type="text" autocomplete="off" spellcheck="false" />
          <p class="hint">Default: ${escapeHtml(DEFAULT_VERCEL_URL)}</p>
        </div>
        <div class="field">
          <label for="apiKey">API key</label>
          <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Enter new key to replace the stored one" />
          <p id="keyState" class="key-state"></p>
        </div>
        <div class="field">
          <label for="agentName">Agent display / @mention name</label>
          <input id="agentName" type="text" autocomplete="off" spellcheck="false" />
        </div>
        <div class="actions">
          <button id="testBtn" type="button">Test connection</button>
          <button id="saveBtn" type="button">Save</button>
          <button id="clearKeyBtn" class="secondary" type="button">Clear stored key</button>
          <button id="settingsBtn" class="secondary" type="button">Open VS Code AI settings</button>
        </div>
        <div id="status" class="status info" hidden></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const gatewayUrlEl = document.getElementById('gatewayUrl');
    const apiKeyEl = document.getElementById('apiKey');
    const agentNameEl = document.getElementById('agentName');
    const keyStateEl = document.getElementById('keyState');
    const statusEl = document.getElementById('status');
    const testBtn = document.getElementById('testBtn');
    const saveBtn = document.getElementById('saveBtn');
    const clearKeyBtn = document.getElementById('clearKeyBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    let clearApiKey = false;

    function applySnapshot(snapshot) {
      if (!snapshot) return;
      gatewayUrlEl.value = snapshot.gatewayUrl || '';
      agentNameEl.value = snapshot.agentName || '';
      keyStateEl.textContent = snapshot.hasApiKey
        ? 'A gateway API key is stored securely.'
        : 'No API key stored yet.';
      if (snapshot.statusMessage) {
        statusEl.hidden = false;
        statusEl.textContent = snapshot.statusMessage;
        statusEl.className = 'status ' + (snapshot.statusKind || 'info');
      }
    }

    function setBusy(busy) {
      testBtn.disabled = busy;
      saveBtn.disabled = busy;
      clearKeyBtn.disabled = busy;
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'init') {
        setBusy(false);
        applySnapshot(msg.snapshot);
      }
    });

    testBtn.addEventListener('click', () => {
      setBusy(true);
      statusEl.hidden = false;
      statusEl.className = 'status info';
      statusEl.textContent = 'Testing connection…';
      vscodeApi.postMessage({
        type: 'testConnection',
        gatewayUrl: gatewayUrlEl.value,
        apiKey: apiKeyEl.value
      });
    });

    saveBtn.addEventListener('click', () => {
      setBusy(true);
      statusEl.hidden = false;
      statusEl.className = 'status info';
      statusEl.textContent = 'Saving…';
      vscodeApi.postMessage({
        type: 'save',
        gatewayUrl: gatewayUrlEl.value,
        apiKey: apiKeyEl.value,
        agentName: agentNameEl.value,
        clearApiKey: clearApiKey
      });
      clearApiKey = false;
      apiKeyEl.value = '';
    });

    clearKeyBtn.addEventListener('click', () => {
      clearApiKey = true;
      apiKeyEl.value = '';
      keyStateEl.textContent = 'Stored key will be cleared when you Save.';
    });

    settingsBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'openVsCodeSettings' });
    });

    applySnapshot(${initial});
    vscodeApi.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
