import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { IssueDetails } from '../types';

interface AnalysisMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

interface IssueAnalysisState {
  issueKey: string;
  model: string;
  confirmed: boolean;
  confirmedAt?: string;
  messages: AnalysisMessage[];
}

interface AnalysisPanelContext {
  issue: IssueDetails;
  state: IssueAnalysisState;
  defaultPrompt: string;
  providerLabel: string;
}

const STORAGE_KEY = 'ticketManager.issueAnalysisStates';

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

function formatDate(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class IssueAnalysisPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly states = new Map<string, IssueAnalysisState>();

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly aiSessionManager: AiSessionManager,
    private readonly getDefaultPrompt: () => string,
    private readonly getDefaultModel: () => string,
    private readonly getProviderLabel: () => string,
    private readonly loadIssue: (issueKey: string) => Promise<IssueDetails>,
    private readonly runAnalysis: (input: {
      issue: IssueDetails;
      question: string;
      model: string;
      history: AnalysisMessage[];
      defaultPrompt: string;
    }) => Promise<string>
  ) {
    this.states = this.loadStates();
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  public isConfirmed(issueKey: string): boolean {
    return this.getState(issueKey).confirmed;
  }

  public markConfirmed(issueKey: string): void {
    const state = this.getState(issueKey);
    state.confirmed = true;
    state.confirmedAt = new Date().toISOString();
    this.persistStates();
    this.postState(issueKey);
  }

  public clearConfirmation(issueKey: string): void {
    const state = this.getState(issueKey);
    if (!state.confirmed) {
      return;
    }
    state.confirmed = false;
    state.confirmedAt = undefined;
    this.persistStates();
    this.postState(issueKey);
  }

  public async open(issueKey: string): Promise<void> {
    const issue = await this.loadIssue(issueKey);
    const state = this.getState(issueKey);
    const existing = this.panels.get(issueKey);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside, true);
      void existing.webview.postMessage({
        type: 'hydrate',
        context: this.buildPanelContext(issue, state)
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ticketManager.issueAnalysis',
      `Analysis ${issueKey}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panels.set(issueKey, panel);
    panel.webview.html = this.renderHtml(panel.webview, this.buildPanelContext(issue, state));

    panel.onDidDispose(() => {
      this.panels.delete(issueKey);
    });

    panel.webview.onDidReceiveMessage(async message => {
      await this.handleMessage(issueKey, message);
    });
  }

  private async handleMessage(issueKey: string, message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (!type) {
      return;
    }

    if (type === 'setModel') {
      const model = (asString(message.model) ?? '').trim();
      const state = this.getState(issueKey);
      state.model = model;
      this.aiSessionManager.setIssueModelOverride(issueKey, model);
      this.persistStates();
      this.postState(issueKey);
      return;
    }

    if (type === 'confirmComplete') {
      this.markConfirmed(issueKey);
      void vscode.window.showInformationMessage(`${issueKey} analysis marked complete.`);
      return;
    }

    if (type === 'clearMessages') {
      const state = this.getState(issueKey);
      state.messages = [];
      state.confirmed = false;
      state.confirmedAt = undefined;
      this.persistStates();
      this.postState(issueKey);
      return;
    }

    if (type === 'submitQuestion') {
      const question = (asString(message.question) ?? '').trim();
      if (!question) {
        return;
      }

      const defaultPrompt = this.getDefaultPrompt().trim();
      if (!defaultPrompt) {
        void vscode.window.showWarningMessage(
          'Set Ticket Manager AI Analysis Default Prompt before running analysis.'
        );
        return;
      }

      const issue = await this.loadIssue(issueKey);
      const state = this.getState(issueKey);
      const model = state.model.trim() || this.getDefaultModel().trim();

      state.messages.push({
        role: 'user',
        text: question,
        createdAt: new Date().toISOString()
      });
      state.confirmed = false;
      state.confirmedAt = undefined;
      this.persistStates();
      this.postState(issueKey);
      this.postBusy(issueKey, true);

      try {
        const reply = await this.runAnalysis({
          issue,
          question,
          model,
          history: [...state.messages],
          defaultPrompt
        });
        state.messages.push({
          role: 'assistant',
          text: reply,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        state.messages.push({
          role: 'assistant',
          text: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
          createdAt: new Date().toISOString()
        });
      } finally {
        this.persistStates();
        this.postState(issueKey);
        this.postBusy(issueKey, false);
      }
    }
  }

  private getState(issueKey: string): IssueAnalysisState {
    const existing = this.states.get(issueKey);
    if (existing) {
      return existing;
    }

    const model =
      this.aiSessionManager.getIssueModelOverride(issueKey)?.trim() ||
      this.getDefaultModel().trim();

    const next: IssueAnalysisState = {
      issueKey,
      model,
      confirmed: false,
      messages: []
    };

    this.states.set(issueKey, next);
    this.persistStates();
    return next;
  }

  private loadStates(): Map<string, IssueAnalysisState> {
    const raw = this.workspaceState.get<IssueAnalysisState[]>(STORAGE_KEY, []);
    const entries = raw
      .filter(item => item && typeof item.issueKey === 'string')
      .map(item => [item.issueKey, item] as const);

    return new Map(entries);
  }

  private persistStates(): void {
    const serialized = [...this.states.values()];
    void this.workspaceState.update(STORAGE_KEY, serialized);
  }

  private postState(issueKey: string): void {
    const panel = this.panels.get(issueKey);
    if (!panel) {
      return;
    }

    void this.loadIssue(issueKey)
      .then(issue => {
        const state = this.getState(issueKey);
        void panel.webview.postMessage({
          type: 'hydrate',
          context: this.buildPanelContext(issue, state)
        });
      })
      .catch(() => {
        // Ignore refresh failures; panel keeps prior state.
      });
  }

  private postBusy(issueKey: string, busy: boolean): void {
    const panel = this.panels.get(issueKey);
    if (!panel) {
      return;
    }

    void panel.webview.postMessage({ type: 'setBusy', busy });
  }

  private buildPanelContext(issue: IssueDetails, state: IssueAnalysisState): AnalysisPanelContext {
    return {
      issue,
      state,
      defaultPrompt: this.getDefaultPrompt().trim(),
      providerLabel: this.getProviderLabel()
    };
  }

  private renderHtml(webview: vscode.Webview, context: AnalysisPanelContext): string {
    const nonce = createNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
    .root { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
    .header { padding: 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); display: grid; gap: 8px; }
    .title { font-size: 13px; font-weight: 600; }
    .meta { font-size: 11px; opacity: 0.85; }
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .input, .select, .textarea, .btn { font: inherit; color: inherit; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
    .input, .select { padding: 4px 8px; min-height: 30px; }
    .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; padding: 6px 10px; cursor: pointer; }
    .btn.secondary { background: transparent; border-color: var(--vscode-input-border); color: var(--vscode-foreground); }
    .btn:disabled { opacity: 0.55; cursor: default; }
    .feed { overflow: auto; padding: 12px; display: grid; gap: 10px; align-content: start; }
    .msg { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 10px; white-space: pre-wrap; line-height: 1.4; }
    .msg-user { background: color-mix(in srgb, var(--vscode-button-background) 14%, transparent); }
    .msg-assistant { background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 35%, transparent); }
    .msg-meta { font-size: 11px; opacity: 0.75; margin-bottom: 6px; }
    .composer { border-top: 1px solid var(--vscode-editorWidget-border); padding: 12px; display: grid; gap: 8px; }
    .textarea { min-height: 92px; width: 100%; resize: vertical; padding: 8px; box-sizing: border-box; }
    .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .status { font-size: 11px; opacity: 0.85; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-editorWidget-border); font-size: 11px; }
    .pill.ok { color: var(--vscode-testing-iconPassed); }
    .pill.pending { color: var(--vscode-testing-iconQueued); }
  </style>
</head>
<body>
  <div class="root">
    <div class="header">
      <div class="title">Ticket Analysis: ${escapeHtml(context.issue.key)}</div>
      <div class="meta">${escapeHtml(context.issue.summary)}<br/>Provider: ${escapeHtml(context.providerLabel)}</div>
      <div class="controls">
        <label>Model</label>
        <input class="input" id="modelInput" value="${escapeHtml(context.state.model || this.getDefaultModel())}" placeholder="model id" />
        <button class="btn secondary" id="saveModelBtn">Save Model</button>
        <span class="pill ${context.state.confirmed ? 'ok' : 'pending'}" id="confirmPill">${context.state.confirmed ? `Confirmed ${escapeHtml(formatDate(context.state.confirmedAt))}` : 'Not confirmed'}</span>
      </div>
      <div class="meta">Default prompt: ${context.defaultPrompt ? 'configured' : 'missing'}.</div>
    </div>

    <div class="feed" id="feed"></div>

    <div class="composer">
      <textarea id="questionInput" class="textarea" placeholder="Ask analysis questions about this ticket..."></textarea>
      <div class="row">
        <span class="status" id="statusLine">Ready</span>
        <div style="display:flex; gap: 8px;">
          <button class="btn secondary" id="clearBtn">Clear Chat</button>
          <button class="btn secondary" id="confirmBtn">Confirm Analysis Complete</button>
          <button class="btn" id="sendBtn">Run Analysis</button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let context = ${JSON.stringify(context)};
    let busy = false;

    const feed = document.getElementById('feed');
    const modelInput = document.getElementById('modelInput');
    const questionInput = document.getElementById('questionInput');
    const sendBtn = document.getElementById('sendBtn');
    const clearBtn = document.getElementById('clearBtn');
    const confirmBtn = document.getElementById('confirmBtn');
    const saveModelBtn = document.getElementById('saveModelBtn');
    const statusLine = document.getElementById('statusLine');
    const confirmPill = document.getElementById('confirmPill');

    function render() {
      feed.innerHTML = '';
      for (const message of context.state.messages || []) {
        const card = document.createElement('div');
        card.className = 'msg ' + (message.role === 'user' ? 'msg-user' : 'msg-assistant');

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.textContent = (message.role === 'user' ? 'You' : 'AI') + ' • ' + new Date(message.createdAt).toLocaleString();

        const body = document.createElement('div');
        body.textContent = message.text || '';

        card.appendChild(meta);
        card.appendChild(body);
        feed.appendChild(card);
      }

      feed.scrollTop = feed.scrollHeight;

      if (context.state.confirmed) {
        confirmPill.textContent = 'Confirmed ' + new Date(context.state.confirmedAt).toLocaleString();
        confirmPill.className = 'pill ok';
      } else {
        confirmPill.textContent = 'Not confirmed';
        confirmPill.className = 'pill pending';
      }

      sendBtn.disabled = busy;
      clearBtn.disabled = busy;
      confirmBtn.disabled = busy;
      saveModelBtn.disabled = busy;
      questionInput.disabled = busy;
      modelInput.disabled = busy;
    }

    sendBtn.addEventListener('click', () => {
      const question = (questionInput.value || '').trim();
      if (!question || busy) {
        return;
      }
      questionInput.value = '';
      statusLine.textContent = 'Running analysis...';
      vscode.postMessage({ type: 'submitQuestion', question });
    });

    clearBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'clearMessages' });
    });

    confirmBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'confirmComplete' });
    });

    saveModelBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'setModel', model: modelInput.value || '' });
      statusLine.textContent = 'Model saved.';
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'hydrate' && message.context) {
        context = message.context;
        if (typeof context.state?.model === 'string') {
          modelInput.value = context.state.model;
        }
        statusLine.textContent = 'Ready';
        render();
      }

      if (message.type === 'setBusy') {
        busy = Boolean(message.busy);
        if (!busy) {
          statusLine.textContent = 'Ready';
        }
        render();
      }
    });

    render();
  </script>
</body>
</html>`;
  }
}
