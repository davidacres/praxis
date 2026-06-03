import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { IssueDetails } from '../types';

export interface AnalysisRepositoryEntry {
  /** Absolute local path or remote URL. */
  source: string;
  /** Optional branch for remote repos. */
  branch?: string;
  /** Optional commit/SHA. */
  commit?: string;
  /** Optional subdirectory within the repo. */
  subdirectory?: string;
  /** Human-readable label (e.g. "my-repo (main)"). */
  label: string;
}

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
  repositories: AnalysisRepositoryEntry[];
}

interface AnalysisPanelContext {
  issue: IssueDetails;
  state: IssueAnalysisState;
  defaultPrompt: string;
  providerLabel: string;
  availableModels: Array<{ id: string; label: string }>;
  workspaceFolders: Array<{ uri: string; name: string }>;
}

const STORAGE_KEY = 'ticketManager.issueAnalysisStates';
const DEFAULT_ANALYSIS_REQUEST =
  'Analyze this ticket using its title, description, comments, and available metadata. Identify missing information, assumptions, risks, and whether it is ready for AI assignment.';

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
  private readonly issues = new Map<string, IssueDetails>();

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly aiSessionManager: AiSessionManager,
    private readonly getDefaultPrompt: () => string,
    private readonly getDefaultModel: () => string,
    private readonly getProviderLabel: () => string,
    private readonly getAvailableModels: () => Array<{ id: string; label: string }>,
    private readonly getWorkspaceFolders: () => Array<{ uri: string; name: string }>,
    private readonly loadIssue: (issueKey: string) => Promise<IssueDetails>,
    private readonly log: (message: string) => void,
    private readonly runAnalysis: (input: {
      issue: IssueDetails;
      question: string;
      model: string;
      history: AnalysisMessage[];
      defaultPrompt: string;
      repositories?: AnalysisRepositoryEntry[];
      onUpdate?: (content: string) => void;
    }) => Promise<string>
  ) {
    this.states = this.loadStates();
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.issues.clear();
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
    this.log(`[IssueAnalysis] Opening analysis panel for ${issueKey}.`);
    const issue = await this.loadIssue(issueKey);
    this.issues.set(issueKey, issue);
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
    panel.webview.onDidReceiveMessage(async message => {
      await this.handleMessage(issueKey, message);
    });

    panel.webview.html = this.renderHtml(panel.webview, this.buildPanelContext(issue, state));

    panel.onDidDispose(() => {
      this.panels.delete(issueKey);
      this.issues.delete(issueKey);
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

    if (type === 'debugLog') {
      const detail = asString(message.detail) ?? '';
      this.log(`[IssueAnalysis] Webview ${issueKey}: ${detail}`);
      return;
    }

    this.log(`[IssueAnalysis] Received webview message '${type}' for ${issueKey}.`);

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
      await this.runSubmitQuestion(issueKey, asString(message.question));
    }

    if (type === 'addRepository') {
      await this.handleAddRepository(issueKey);
      return;
    }

    if (type === 'addWorkspaceRepo') {
      await this.handleAddWorkspaceRepo(issueKey);
      return;
    }

    if (type === 'removeRepository') {
      const index = typeof message.index === 'number' ? message.index : -1;
      const state = this.getState(issueKey);
      if (index >= 0 && index < state.repositories.length) {
        state.repositories.splice(index, 1);
        this.persistStates();
        this.postState(issueKey);
      }
      return;
    }
  }

  public async submitQuestion(issueKey: string, question?: string): Promise<void> {
    await this.runSubmitQuestion(issueKey, question);
  }

  private async runSubmitQuestion(issueKey: string, question?: string): Promise<void> {
    const effectiveQuestion = (question ?? '').trim() || DEFAULT_ANALYSIS_REQUEST;
    const state = this.getState(issueKey);
    const model = state.model.trim() || this.getDefaultModel().trim();
    this.log(`[IssueAnalysis] Starting analysis for ${issueKey} with model '${model || 'default'}'.`);

    state.messages.push({
      role: 'user',
      text: effectiveQuestion,
      createdAt: new Date().toISOString()
    });
    const assistantMessage: AnalysisMessage = {
      role: 'assistant',
      text: 'Analyzing... ',
      createdAt: new Date().toISOString()
    };
    state.messages.push(assistantMessage);
    state.confirmed = false;
    state.confirmedAt = undefined;
    this.persistStates();
    this.postState(issueKey);
    this.postBusy(issueKey, true);

    try {
      const defaultPrompt = this.getDefaultPrompt().trim();
      if (!defaultPrompt) {
        this.log(`[IssueAnalysis] Analysis blocked for ${issueKey}: default prompt is missing.`);
        assistantMessage.text = 'Analysis failed: Set Ticket Manager AI Analysis Default Prompt before running analysis.';
        void vscode.window.showWarningMessage(
          'Set Ticket Manager AI Analysis Default Prompt before running analysis.'
        );
        return;
      }

      const issue = await this.loadIssue(issueKey);
      this.issues.set(issueKey, issue);
      const reply = await this.runAnalysis({
        issue,
        question: effectiveQuestion,
        model,
        history: [...state.messages],
        defaultPrompt,
        repositories: state.repositories,
        onUpdate: content => {
          assistantMessage.text = content;
          this.postState(issueKey);
        }
      });
      assistantMessage.text = reply;
      this.log(`[IssueAnalysis] Analysis completed for ${issueKey}.`);
    } catch (error) {
      this.log(`[IssueAnalysis] Analysis failed for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`);
      assistantMessage.text = `Analysis failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.persistStates();
      this.postState(issueKey);
      this.postBusy(issueKey, false);
      this.log(`[IssueAnalysis] Analysis finished for ${issueKey}; busy=${false}.`);
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
      messages: [],
      repositories: []
    };

    this.states.set(issueKey, next);
    this.persistStates();
    return next;
  }

  private loadStates(): Map<string, IssueAnalysisState> {
    const raw = this.workspaceState.get<IssueAnalysisState[]>(STORAGE_KEY, []);
    const entries = raw
      .filter(item => item && typeof item.issueKey === 'string')
      .map(item => [item.issueKey, { ...item, repositories: item.repositories ?? [] }] as const);

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

    const cachedIssue = this.issues.get(issueKey);
    if (cachedIssue) {
      const state = this.getState(issueKey);
      void panel.webview.postMessage({
        type: 'hydrate',
        context: this.buildPanelContext(cachedIssue, state)
      });
      return;
    }

    void this.loadIssue(issueKey)
      .then(issue => {
        this.issues.set(issueKey, issue);
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
      providerLabel: this.getProviderLabel(),
      availableModels: this.getAvailableModels(),
      workspaceFolders: this.getWorkspaceFolders()
    };
  }

  private async handleAddRepository(issueKey: string): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add Repository Folder',
      title: 'Select repository or code folder for analysis'
    });
    if (!result || result.length === 0) {
      return;
    }

    const state = this.getState(issueKey);
    for (const uri of result) {
      const fsPath = uri.fsPath;
      const folderName = fsPath.replaceAll('\\', '/').split('/').pop() ?? fsPath;
      const entry: AnalysisRepositoryEntry = {
        source: fsPath,
        label: folderName
      };
      state.repositories.push(entry);
      this.log(`[IssueAnalysis] Added repository '${folderName}' (${fsPath}) for ${issueKey}.`);
    }

    this.persistStates();
    this.postState(issueKey);
  }

  private async handleAddWorkspaceRepo(issueKey: string): Promise<void> {
    const folders = this.getWorkspaceFolders();
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('No workspace folders are open.');
      return;
    }

    const items = folders.map(folder => ({
      label: folder.name,
      description: folder.uri,
      uri: folder.uri
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a workspace folder to add',
      canPickMany: true
    });

    if (!picked || picked.length === 0) {
      return;
    }

    const state = this.getState(issueKey);
    for (const item of picked) {
      const entry: AnalysisRepositoryEntry = {
        source: item.uri,
        label: item.label
      };
      state.repositories.push(entry);
      this.log(`[IssueAnalysis] Added workspace folder '${item.label}' (${item.uri}) for ${issueKey}.`);
    }

    this.persistStates();
    this.postState(issueKey);
  }

  private renderHtml(webview: vscode.Webview, context: AnalysisPanelContext): string {
    const nonce = createNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const contextLiteral = JSON.stringify(context)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const selectedModel = context.state.model || this.getDefaultModel();
    const hasSelectedModel = context.availableModels.some(model => model.id === selectedModel);
    const modelOptions = [
      `<option value="" ${selectedModel ? '' : 'selected'}>Default${this.getDefaultModel().trim() ? ` (${escapeHtml(this.getDefaultModel().trim())})` : ''}</option>`,
      ...context.availableModels.map(model =>
        `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.label)}</option>`
      ),
      ...(selectedModel && !hasSelectedModel
        ? [`<option value="${escapeHtml(selectedModel)}" selected>${escapeHtml(selectedModel)}</option>`]
        : [])
    ].join('');
    const script = String.raw`
    const vscode = acquireVsCodeApi();
    let context = ${contextLiteral};
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
    const repoList = document.getElementById('repoList');
    const addRepoBtn = document.getElementById('addRepoBtn');
    const addWorkspaceRepoBtn = document.getElementById('addWorkspaceRepoBtn');
    const issueKey = ${JSON.stringify(context.issue.key)};

    function debugLog(detail) {
      console.log('[IssueAnalysis]', detail);
      try {
        vscode.postMessage({ type: 'debugLog', detail: String(detail || '') });
      } catch {
        // Ignore logging failures in the webview.
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderInlineMarkdown(text) {
      const tick = String.fromCharCode(96);
      let html = escapeHtml(text);
      html = html.replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
      return html;
    }

    function renderMarkdown(text) {
      const codeFence = String.fromCharCode(96).repeat(3);
      const source = String(text || '').replace(/\r\n/g, '\n');
      const lines = source.split('\n');
      const blocks = [];
      let index = 0;

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
          index += 1;
          continue;
        }

        if (trimmed.startsWith(codeFence)) {
          const codeLines = [];
          index += 1;
          while (index < lines.length && !lines[index].trim().startsWith(codeFence)) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) {
            index += 1;
          }
          blocks.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
          continue;
        }

        if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
          blocks.push('<hr />');
          index += 1;
          continue;
        }

        const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
        if (headingMatch) {
          const level = headingMatch[1].length;
          blocks.push('<h' + level + '>' + renderInlineMarkdown(headingMatch[2]) + '</h' + level + '>');
          index += 1;
          continue;
        }

        if (trimmed.startsWith('>')) {
          const quoteLines = [];
          while (index < lines.length && lines[index].trim().startsWith('>')) {
            quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
            index += 1;
          }
          blocks.push('<blockquote>' + renderMarkdown(quoteLines.join('\n')) + '</blockquote>');
          continue;
        }

        const unorderedMatch = /^[-*]\s+(.+)$/.exec(trimmed);
        if (unorderedMatch) {
          const items = [];
          while (index < lines.length) {
            const match = /^[-*]\s+(.+)$/.exec(lines[index].trim());
            if (!match) {
              break;
            }
            items.push('<li>' + renderInlineMarkdown(match[1]) + '</li>');
            index += 1;
          }
          blocks.push('<ul>' + items.join('') + '</ul>');
          continue;
        }

        const orderedMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
        if (orderedMatch) {
          const items = [];
          while (index < lines.length) {
            const match = /^\d+\.\s+(.+)$/.exec(lines[index].trim());
            if (!match) {
              break;
            }
            items.push('<li>' + renderInlineMarkdown(match[1]) + '</li>');
            index += 1;
          }
          blocks.push('<ol>' + items.join('') + '</ol>');
          continue;
        }

        const paragraphLines = [];
        while (index < lines.length && lines[index].trim()) {
          const candidate = lines[index].trim();
          if (
            candidate.startsWith(codeFence) ||
            candidate.startsWith('>') ||
            /^#{1,4}\s+/.test(candidate) ||
            /^[-*]\s+/.test(candidate) ||
            /^\d+\.\s+/.test(candidate) ||
            /^---+$/.test(candidate) ||
            /^\*\*\*+$/.test(candidate)
          ) {
            break;
          }
          paragraphLines.push(candidate);
          index += 1;
        }
        blocks.push('<p>' + renderInlineMarkdown(paragraphLines.join('<br />')) + '</p>');
      }

      return blocks.join('');
    }

    function render() {
      feed.innerHTML = '';
      for (const message of context.state.messages || []) {
        const card = document.createElement('div');
        card.className = 'msg ' + (message.role === 'user' ? 'msg-user' : 'msg-assistant');

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.textContent = (message.role === 'user' ? 'You' : 'AI') + ' • ' + new Date(message.createdAt).toLocaleString();

        const body = document.createElement('div');
        body.className = 'msg-body';
        body.innerHTML = renderMarkdown(message.text || '');

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
      addRepoBtn.disabled = busy;
      addWorkspaceRepoBtn.disabled = busy;

      repoList.innerHTML = '';
      for (let i = 0; i < (context.state.repositories || []).length; i++) {
        const repo = context.state.repositories[i];
        const chip = document.createElement('span');
        chip.className = 'chip';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'chip-label';
        labelSpan.textContent = repo.label || repo.source;
        chip.appendChild(labelSpan);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'chip-remove';
        removeBtn.textContent = '\\u00d7';
        removeBtn.dataset.index = String(i);
        removeBtn.addEventListener('click', function() {
          if (busy) { return; }
          vscode.postMessage({ type: 'removeRepository', index: Number(this.dataset.index) });
        });
        chip.appendChild(removeBtn);
        repoList.appendChild(chip);
      }
    }

    function runAnalysis() {
      const question = (questionInput.value || '').trim();
      if (busy) {
        debugLog('Run Analysis ignored because the panel is already busy.');
        return;
      }
      debugLog('Run Analysis clicked.');
      busy = true;
      statusLine.textContent = 'Running analysis...';
      debugLog('Submitting analysis request for issue ' + issueKey + ' with questionLength=' + question.length + '.');
      render();
      questionInput.value = '';
      vscode.postMessage({ type: 'submitQuestion', question });
    }

    sendBtn.addEventListener('click', () => {
      runAnalysis();
    });
    questionInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      runAnalysis();
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

    addRepoBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'addRepository' });
    });

    addWorkspaceRepoBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'addWorkspaceRepo' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }

      debugLog('Received host message ' + message.type + '.');

      if (message.type === 'hydrate' && message.context) {
        context = message.context;
        if (typeof context.state?.model === 'string') {
          modelInput.value = context.state.model;
        } else {
          modelInput.value = '';
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

    debugLog('Analysis webview initialized for ' + issueKey + '.');
    render();
    `;
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
    .msg { border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 10px; line-height: 1.4; }
    .msg-user { background: color-mix(in srgb, var(--vscode-button-background) 14%, transparent); }
    .msg-assistant { background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 35%, transparent); }
    .msg-meta { font-size: 11px; opacity: 0.75; margin-bottom: 6px; }
    .msg-body { display: grid; gap: 8px; }
    .msg-body > :first-child { margin-top: 0; }
    .msg-body > :last-child { margin-bottom: 0; }
    .msg-body p, .msg-body ul, .msg-body ol, .msg-body blockquote, .msg-body pre, .msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4 { margin: 0; }
    .msg-body ul, .msg-body ol { padding-left: 20px; }
    .msg-body li + li { margin-top: 4px; }
    .msg-body blockquote {
      padding-left: 10px;
      border-left: 3px solid var(--vscode-textLink-foreground);
      opacity: 0.9;
    }
    .msg-body code {
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 0.95em;
      padding: 1px 4px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 60%, transparent);
    }
    .msg-body pre {
      overflow: auto;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-textCodeBlock-background);
    }
    .msg-body pre code {
      padding: 0;
      background: transparent;
      border-radius: 0;
    }
    .msg-body a { color: var(--vscode-textLink-foreground); }
    .msg-body hr {
      border: 0;
      border-top: 1px solid var(--vscode-editorWidget-border);
      margin: 0;
    }
    .composer { border-top: 1px solid var(--vscode-editorWidget-border); padding: 12px; display: grid; gap: 8px; }
    .textarea { min-height: 92px; width: 100%; resize: vertical; padding: 8px; box-sizing: border-box; }
    .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .status { font-size: 11px; opacity: 0.85; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-editorWidget-border); font-size: 11px; }
    .pill.ok { color: var(--vscode-testing-iconPassed); }
    .pill.pending { color: var(--vscode-testing-iconQueued); }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-input-border); font-size: 11px; background: var(--vscode-input-background); }
    .chip-remove { background: none; border: none; color: inherit; cursor: pointer; padding: 0 2px; font-size: 12px; opacity: 0.7; line-height: 1; }
    .chip-remove:hover { opacity: 1; }
    .repo-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .repo-chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; min-height: 24px; }
  </style>
</head>
<body>
  <div class="root">
    <div class="header">
      <div class="title">Ticket Analysis: ${escapeHtml(context.issue.key)}</div>
      <div class="meta">${escapeHtml(context.issue.summary)}<br/>Provider: ${escapeHtml(context.providerLabel)}</div>
      <div class="controls">
        <label>Model</label>
        <select class="select" id="modelInput">${modelOptions}</select>
        <button class="btn secondary" id="saveModelBtn">Save Model</button>
        <span class="pill ${context.state.confirmed ? 'ok' : 'pending'}" id="confirmPill">${context.state.confirmed ? `Confirmed ${escapeHtml(formatDate(context.state.confirmedAt))}` : 'Not confirmed'}</span>
      </div>
      <div class="repo-row">
        <label>Repos</label>
        <div class="repo-chips" id="repoList"></div>
        <button class="btn secondary" id="addRepoBtn">+ Add</button>
        <button class="btn secondary" id="addWorkspaceRepoBtn">Workspace</button>
      </div>
      <div class="meta">Default prompt: ${context.defaultPrompt ? 'configured' : 'missing'}.</div>
    </div>

    <div class="feed" id="feed"></div>

    <div class="composer">
      <textarea id="questionInput" class="textarea" placeholder="Ask a follow-up question about this ticket. Attach repos above for code context."></textarea>
      <div class="row">
        <span class="status" id="statusLine">Ready</span>
        <div style="display:flex; gap: 8px;">
          <button type="button" class="btn secondary" id="clearBtn">Clear Chat</button>
          <button type="button" class="btn secondary" id="confirmBtn">Confirm Analysis Complete</button>
          <button type="button" class="btn" id="sendBtn">Run Analysis</button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }
}
