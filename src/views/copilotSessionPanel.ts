import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { CopilotAgentService } from '../ai/copilotAgentService';
import type { AgentSessionRecord, AgentEventSummary } from '../ai/agentTypes';

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const STATE_LABELS: Record<string, { label: string; icon: string }> = {
  'not_started': { label: 'Not Started', icon: '⏳' },
  'planning': { label: 'Planning', icon: '📋' },
  'awaiting_approval': { label: 'Awaiting Approval', icon: '⚠️' },
  'executing': { label: 'Executing', icon: '⚙️' },
  'awaiting_input': { label: 'Awaiting Input', icon: '❓' },
  'completed': { label: 'Completed', icon: '✅' },
  'failed': { label: 'Failed', icon: '❌' },
  'aborted': { label: 'Aborted', icon: '🛑' }
};

const EVENT_ICONS: Record<string, string> = {
  'session_start': '🚀',
  'intent': '🎯',
  'message': '💬',
  'plan': '📋',
  'tool_start': '🔧',
  'tool_complete': '✔️',
  'permission_requested': '⚠️',
  'permission_completed': '🔓',
  'user_input_requested': '❓',
  'user_input_completed': '💬',
  'idle': '💤',
  'task_complete': '✅',
  'error': '❌',
  'aborted': '🛑',
  'info': 'ℹ️',
  'warning': '⚠️'
};

/** Manages one webview panel per agent session. */
export class CopilotSessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly agentService: CopilotAgentService
  ) {
    // Listen for session changes and push updates to open panels
    this.disposables.push(
      this.sessionManager.onDidChangeAgentSession((record) => {
        const panel = this.panels.get(record.issueKey);
        if (panel) {
          this.updatePanel(panel, record);
        }
      })
    );
  }

  /** Open or focus the session panel for an issue. */
  public open(issueKey: string): void {
    const existing = this.panels.get(issueKey);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }

    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) {
      vscode.window.showWarningMessage(`No agent session found for ${issueKey}.`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ticketManager.copilotSession',
      `🤖 Agent: ${issueKey}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panels.set(issueKey, panel);

    panel.onDidDispose(() => {
      this.panels.delete(issueKey);
    });

    panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(issueKey, message);
    });

    this.renderFull(panel, record);
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ── Message handling ───────────────────────────────────────────

  private async handleMessage(issueKey: string, message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);

    switch (type) {
      case 'respondInput': {
        const response = asString(message.response);
        if (response) {
          this.agentService.respondToInput(issueKey, response);
        }
        break;
      }
      case 'respondPermission': {
        const decision = asString(message.decision);
        if (decision === 'allow_once' || decision === 'allow_always' || decision === 'deny') {
          this.agentService.respondToPermission(issueKey, decision);
        }
        break;
      }
      case 'abort': {
        await this.agentService.abortTask(issueKey);
        break;
      }
    }
  }

  // ── Rendering ──────────────────────────────────────────────────

  private updatePanel(panel: vscode.WebviewPanel, record: AgentSessionRecord): void {
    // Push incremental update via postMessage
    panel.webview.postMessage({
      type: 'update',
      state: record.state,
      events: record.events,
      planText: record.planText,
      stepCount: record.stepCount
    });
  }

  private renderFull(panel: vscode.WebviewPanel, record: AgentSessionRecord): void {
    const nonce = createNonce();
    panel.webview.html = this.getHtml(nonce, record);
  }

  private getHtml(nonce: string, record: AgentSessionRecord): string {
    const task = record.taskDefinition;
    const stateInfo = STATE_LABELS[record.state] ?? { label: record.state, icon: '❔' };

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Session: ${escapeHtml(record.issueKey)}</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, #555);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 16px; }
    h2 { font-size: 14px; margin-bottom: 8px; }
    h3 { font-size: 13px; margin-bottom: 6px; font-weight: 600; }

    .header {
      display: flex; align-items: center; gap: 12px;
      border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 16px;
    }
    .header h2 { flex: 1; font-size: 16px; margin-bottom: 0; }
    .state-badge {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--badge-bg); color: var(--badge-fg);
      padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;
    }
    .abort-btn {
      background: var(--vscode-errorForeground, #f44); color: #fff;
      border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px;
    }
    .abort-btn:hover { opacity: 0.85; }
    .abort-btn:disabled { opacity: 0.4; cursor: default; }

    .card {
      border: 1px solid var(--border); border-radius: 6px;
      padding: 12px; margin-bottom: 16px;
    }
    .card summary { cursor: pointer; font-weight: 600; font-size: 13px; }
    .card .field { margin-top: 6px; font-size: 12px; line-height: 1.5; }
    .card .field strong { display: inline-block; min-width: 120px; }

    #activity-feed {
      border: 1px solid var(--border); border-radius: 6px;
      max-height: 50vh; overflow-y: auto; padding: 8px;
    }
    .event-row {
      display: flex; gap: 8px; padding: 4px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
      font-size: 12px; line-height: 1.4;
    }
    .event-row:last-child { border-bottom: none; }
    .event-icon { flex-shrink: 0; width: 20px; text-align: center; }
    .event-time { flex-shrink: 0; color: var(--vscode-descriptionForeground); min-width: 65px; }
    .event-summary { flex: 1; word-break: break-word; }

    .plan-section { margin-bottom: 16px; }
    .plan-content {
      background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 10px; font-size: 12px;
      white-space: pre-wrap; max-height: 200px; overflow-y: auto;
    }

    .input-area {
      margin-top: 16px; border: 1px solid var(--border);
      border-radius: 6px; padding: 12px; display: none;
    }
    .input-area.visible { display: block; }
    .input-area h3 { margin-bottom: 8px; }
    .input-area textarea {
      width: 100%; min-height: 60px; resize: vertical;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--input-border); border-radius: 4px; padding: 8px;
      font-family: var(--vscode-font-family); font-size: 12px;
    }
    .input-area .btn-row { margin-top: 8px; display: flex; gap: 8px; }
    .btn {
      padding: 5px 14px; border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-weight: 500;
      background: var(--btn-bg); color: var(--btn-fg);
    }
    .btn:hover { background: var(--btn-hover); }
    .btn-secondary {
      background: var(--btn-secondary-bg); color: var(--btn-secondary-fg);
    }
    .btn-deny {
      background: var(--vscode-errorForeground, #f44); color: #fff;
    }

    .step-counter { font-size: 11px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="header">
    <h2>🤖 ${escapeHtml(record.issueKey)}</h2>
    <span id="state-badge" class="state-badge">${stateInfo.icon} ${escapeHtml(stateInfo.label)}</span>
    <span id="step-counter" class="step-counter">Steps: ${record.stepCount}/${task.maxSteps ?? 50}</span>
    <button id="abort-btn" class="abort-btn" ${this.isTerminal(record.state) ? 'disabled' : ''}>Abort</button>
  </div>

  <details class="card" open>
    <summary>Task Definition</summary>
    <div class="field"><strong>Goal:</strong> ${escapeHtml(task.goal)}</div>
    <div class="field"><strong>Scope:</strong> ${escapeHtml(task.scope)}</div>
    <div class="field"><strong>Done when:</strong> ${escapeHtml(task.definitionOfDone)}</div>
    ${task.nonGoals?.length ? `<div class="field"><strong>Non-goals:</strong> ${task.nonGoals.map(g => escapeHtml(g)).join(', ')}</div>` : ''}
  </details>

  <div id="plan-section" class="plan-section" style="${record.planText ? '' : 'display:none'}">
    <h3>📋 Agent Plan</h3>
    <div id="plan-content" class="plan-content">${record.planText ? escapeHtml(record.planText) : ''}</div>
  </div>

  <h3>Activity Feed</h3>
  <div id="activity-feed">
    ${this.renderEvents(record.events)}
  </div>

  <div id="input-area" class="input-area ${record.state === 'awaiting_input' ? 'visible' : ''}">
    <h3>❓ Agent is asking for input</h3>
    <textarea id="user-response" placeholder="Type your response..."></textarea>
    <div class="btn-row">
      <button id="send-input" class="btn">Send</button>
    </div>
  </div>

  <div id="permission-area" class="input-area ${record.state === 'awaiting_approval' ? 'visible' : ''}">
    <h3>⚠️ Permission Required</h3>
    <p id="permission-desc" style="font-size: 12px; margin-bottom: 8px;">The agent is requesting permission to proceed.</p>
    <div class="btn-row">
      <button id="approve-once" class="btn">Approve Once</button>
      <button id="approve-always" class="btn btn-secondary">Approve for Task</button>
      <button id="deny-perm" class="btn btn-deny">Deny</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const feedEl = document.getElementById('activity-feed');
    const stateBadgeEl = document.getElementById('state-badge');
    const stepCounterEl = document.getElementById('step-counter');
    const abortBtn = document.getElementById('abort-btn');
    const inputArea = document.getElementById('input-area');
    const permArea = document.getElementById('permission-area');
    const sendBtn = document.getElementById('send-input');
    const textarea = document.getElementById('user-response');

    const stateLabels = ${JSON.stringify(STATE_LABELS)};
    const eventIcons = ${JSON.stringify(EVENT_ICONS)};
    const maxSteps = ${task.maxSteps ?? 50};

    let knownEventCount = ${record.events.length};

    function formatTime(ts) {
      try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
      catch { return ''; }
    }

    function renderEventRow(ev) {
      const icon = eventIcons[ev.type] || '•';
      return '<div class="event-row">'
        + '<span class="event-icon">' + icon + '</span>'
        + '<span class="event-time">' + formatTime(ev.timestamp) + '</span>'
        + '<span class="event-summary">' + escapeHtml(ev.summary) + '</span>'
        + '</div>';
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    const terminalStates = new Set(['completed', 'failed', 'aborted']);

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'update') return;

      // Update state badge
      const info = stateLabels[msg.state] || { label: msg.state, icon: '❔' };
      stateBadgeEl.textContent = info.icon + ' ' + info.label;

      // Steps
      stepCounterEl.textContent = 'Steps: ' + (msg.stepCount || 0) + '/' + maxSteps;

      // Abort button
      abortBtn.disabled = terminalStates.has(msg.state);

      // Plan
      if (msg.planText) {
        const planSection = document.getElementById('plan-section');
        planSection.style.display = '';
        document.getElementById('plan-content').textContent = msg.planText;
      }

      // Append new events
      if (msg.events && msg.events.length > knownEventCount) {
        const newEvents = msg.events.slice(knownEventCount);
        feedEl.insertAdjacentHTML('beforeend', newEvents.map(renderEventRow).join(''));
        knownEventCount = msg.events.length;
        feedEl.scrollTop = feedEl.scrollHeight;
      }

      // Input/permission areas
      inputArea.classList.toggle('visible', msg.state === 'awaiting_input');
      permArea.classList.toggle('visible', msg.state === 'awaiting_approval');
    });

    abortBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'abort' });
    });

    sendBtn.addEventListener('click', () => {
      const response = textarea.value.trim();
      if (response) {
        vscode.postMessage({ type: 'respondInput', response });
        textarea.value = '';
      }
    });

    document.getElementById('approve-once').addEventListener('click', () => {
      vscode.postMessage({ type: 'respondPermission', decision: 'allow_once' });
    });
    document.getElementById('approve-always').addEventListener('click', () => {
      vscode.postMessage({ type: 'respondPermission', decision: 'allow_always' });
    });
    document.getElementById('deny-perm').addEventListener('click', () => {
      vscode.postMessage({ type: 'respondPermission', decision: 'deny' });
    });

    // Auto-scroll on initial load
    feedEl.scrollTop = feedEl.scrollHeight;
  </script>
</body>
</html>`;
  }

  private renderEvents(events: AgentEventSummary[]): string {
    return events.map(ev => {
      const icon = EVENT_ICONS[ev.type] ?? '•';
      const time = this.formatTime(ev.timestamp);
      return `<div class="event-row">
        <span class="event-icon">${icon}</span>
        <span class="event-time">${escapeHtml(time)}</span>
        <span class="event-summary">${escapeHtml(ev.summary)}</span>
      </div>`;
    }).join('');
  }

  private formatTime(ts: string): string {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  }

  private isTerminal(state: string): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }
}
