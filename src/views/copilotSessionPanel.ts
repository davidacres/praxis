import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { CopilotAgentService } from '../ai/copilotAgentService';
import type { AgentSessionRecord, AgentEventSummary } from '../ai/agentTypes';
import type { AiAssignment, AiProvider } from '../types';

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

function formatDate(value: string | undefined): string {
  if (!value) {
    return 'Unknown';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  claude: 'Claude',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'GitHub Copilot SDK'
};

const STATE_LABELS: Record<string, { label: string; icon: string }> = {
  'not_started': { label: 'Not Started', icon: '⏳' },
  'planning': { label: 'Planning', icon: '📋' },
  'awaiting_approval': { label: 'Awaiting Approval', icon: '⚠️' },
  'executing': { label: 'Executing', icon: '⚙️' },
  'awaiting_input': { label: 'Awaiting Input', icon: '❓' },
  'completed': { label: 'Completed', icon: '✅' },
  'failed': { label: 'Failed', icon: '❌' },
  'aborted': { label: 'Aborted', icon: '🛑' },
  active: { label: 'Assigned', icon: '🤖' }
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

function resolveAssignmentLabel(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): string {
  if (assignment?.label?.trim()) {
    return assignment.label.trim();
  }
  if (assignment) {
    return PROVIDER_LABELS[assignment.provider] ?? assignment.provider;
  }
  if (record) {
    return PROVIDER_LABELS['copilot-cli'];
  }
  return 'AI Session';
}

function resolveAssignmentStatus(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): { label: string; icon: string } {
  if (record) {
    return STATE_LABELS[record.state] ?? { label: record.state, icon: '❔' };
  }
  if (assignment) {
    return STATE_LABELS[assignment.status] ?? { label: assignment.status, icon: '❔' };
  }
  return { label: 'Unknown', icon: '❔' };
}

/** Manages one webview panel per AI session. */
export class CopilotSessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly agentService: CopilotAgentService,
    private readonly onAbandonSession: (issueKey: string) => Promise<void>
  ) {
    this.disposables.push(
      this.sessionManager.onDidChangeSession(({ issueKey }) => {
        const panel = this.panels.get(issueKey);
        if (panel) {
          this.renderFull(panel, issueKey);
        }
      }),
      this.sessionManager.onDidChangeAgentSession(record => {
        const panel = this.panels.get(record.issueKey);
        if (panel) {
          this.updatePanel(panel, record.issueKey);
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

    const assignment = this.sessionManager.getSession(issueKey);
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!assignment && !record) {
      vscode.window.showWarningMessage(`No AI session found for ${issueKey}.`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ticketManager.aiSession',
      `🤖 AI Session: ${issueKey}`,
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
    panel.webview.onDidReceiveMessage(message => {
      void this.handleMessage(issueKey, message);
    });

    this.renderFull(panel, issueKey);
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

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
        await this.onAbandonSession(issueKey);
        break;
      }
    }
  }

  private updatePanel(panel: vscode.WebviewPanel, issueKey: string): void {
    const assignment = this.sessionManager.getSession(issueKey);
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!assignment && !record) {
      this.renderFull(panel, issueKey);
      return;
    }
    if (!record) {
      this.renderFull(panel, issueKey);
      return;
    }

    panel.webview.postMessage({
      type: 'update',
      state: record.state,
      events: record.events,
      planText: record.planText,
      stepCount: record.stepCount,
      hasAgentSession: true
    });
  }

  private renderFull(panel: vscode.WebviewPanel, issueKey: string): void {
    const nonce = createNonce();
    panel.webview.html = this.getHtml(
      nonce,
      issueKey,
      this.sessionManager.getSession(issueKey),
      this.sessionManager.getAgentSession(issueKey)
    );
  }

  private getHtml(
    nonce: string,
    issueKey: string,
    assignment: AiAssignment | undefined,
    record: AgentSessionRecord | undefined
  ): string {
    const statusInfo = resolveAssignmentStatus(assignment, record);
    const task = record?.taskDefinition;
    const assignmentLabel = resolveAssignmentLabel(assignment, record);
    const sessionId = assignment?.sessionId ?? record?.sessionId ?? issueKey;
    const startedAt = assignment?.assignedAt ?? record?.startedAt;
    const hasLiveAgentSession = Boolean(record);
    const maxSteps = Number(task?.maxSteps ?? 50);
    const isTerminal = record ? this.isTerminal(record.state) : assignment?.status !== 'active';
    const activityFeed = record ? this.renderEvents(record.events) : '';
    const liveSessionSection = hasLiveAgentSession
      ? `<details class="card" open>
          <summary>Task Definition</summary>
          <div class="field"><strong>Goal:</strong> ${escapeHtml(task?.goal ?? '—')}</div>
          <div class="field"><strong>Scope:</strong> ${escapeHtml(task?.scope ?? '—')}</div>
          <div class="field"><strong>Done when:</strong> ${escapeHtml(task?.definitionOfDone ?? '—')}</div>
          ${task?.nonGoals?.length ? `<div class="field"><strong>Non-goals:</strong> ${task.nonGoals.map(goal => escapeHtml(goal)).join(', ')}</div>` : ''}
        </details>

        <div id="plan-section" class="plan-section" style="${record?.planText ? '' : 'display:none'}">
          <h3>Plan</h3>
          <div id="plan-content" class="plan-content">${record?.planText ? escapeHtml(record.planText) : ''}</div>
        </div>

        <h3>Activity Feed</h3>
        <div id="activity-feed">${activityFeed}</div>

        <div id="input-area" class="input-area ${record?.state === 'awaiting_input' ? 'visible' : ''}">
          <h3>Agent input requested</h3>
          <textarea id="user-response" placeholder="Type your response..."></textarea>
          <div class="btn-row">
            <button id="send-input" class="btn">Send</button>
          </div>
        </div>

        <div id="permission-area" class="input-area ${record?.state === 'awaiting_approval' ? 'visible' : ''}">
          <h3>Permission Required</h3>
          <p id="permission-desc" class="supporting-text">The agent is requesting permission to proceed.</p>
          <div class="btn-row">
            <button id="approve-once" class="btn">Approve Once</button>
            <button id="approve-always" class="btn btn-secondary">Approve for Task</button>
            <button id="deny-perm" class="btn btn-deny">Deny</button>
          </div>
        </div>`
      : `<div class="card">
          <h3>No live agent activity</h3>
          <div class="field">This AI assignment does not currently have a running agent event stream. If you delegate the issue to Copilot, live planning and execution events will appear here.</div>
        </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Session: ${escapeHtml(issueKey)}</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
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
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
    }
    h2, h3 { margin: 0 0 8px; }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .header-main {
      flex: 1;
      min-width: 0;
    }
    .header-title {
      font-size: 16px;
      font-weight: 700;
    }
    .header-meta {
      margin-top: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    .state-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .abort-btn {
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      background: var(--vscode-errorForeground, #f44);
      color: #fff;
      cursor: pointer;
      font-size: 12px;
    }
    .abort-btn:hover { opacity: 0.85; }
    .abort-btn:disabled { opacity: 0.4; cursor: default; }
    .card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .card summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .field {
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.5;
    }
    .field strong {
      display: inline-block;
      min-width: 130px;
    }
    .supporting-text {
      margin: 0 0 8px;
      font-size: 12px;
      color: var(--muted);
    }
    .plan-section { margin-bottom: 16px; }
    .plan-content {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }
    #activity-feed {
      border: 1px solid var(--border);
      border-radius: 6px;
      max-height: 50vh;
      overflow-y: auto;
      padding: 8px;
      margin-bottom: 16px;
    }
    .event-row {
      display: flex;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
      font-size: 12px;
      line-height: 1.4;
    }
    .event-row:last-child { border-bottom: none; }
    .event-icon { flex-shrink: 0; width: 20px; text-align: center; }
    .event-time { flex-shrink: 0; color: var(--muted); min-width: 65px; }
    .event-summary { flex: 1; word-break: break-word; }
    .input-area {
      margin-top: 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      display: none;
    }
    .input-area.visible { display: block; }
    .input-area textarea {
      width: 100%;
      min-height: 60px;
      resize: vertical;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .btn-row {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 5px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    .btn:hover { background: var(--btn-hover); }
    .btn-secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }
    .btn-deny {
      background: var(--vscode-errorForeground, #f44);
      color: #fff;
    }
    .step-counter {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-main">
      <div class="header-title">🤖 ${escapeHtml(issueKey)}</div>
      <div class="header-meta">${escapeHtml(assignmentLabel)} • Session ${escapeHtml(sessionId.slice(0, 8))}</div>
    </div>
    <span id="state-badge" class="state-badge">${statusInfo.icon} ${escapeHtml(statusInfo.label)}</span>
    <span id="step-counter" class="step-counter">${hasLiveAgentSession ? `Steps: ${record?.stepCount ?? 0}/${maxSteps}` : `Assigned: ${escapeHtml(formatDate(startedAt))}`}</span>
    <button id="abort-btn" class="abort-btn" ${isTerminal ? 'disabled' : ''}>Abandon Session</button>
  </div>

  <div class="card">
    <h3>Session Details</h3>
    <div class="field"><strong>Agent:</strong> <span id="agent-label">${escapeHtml(assignmentLabel)}</span></div>
    <div class="field"><strong>Session ID:</strong> ${escapeHtml(sessionId)}</div>
    <div class="field"><strong>Status:</strong> <span id="status-label">${escapeHtml(statusInfo.label)}</span></div>
    <div class="field"><strong>Started:</strong> ${escapeHtml(formatDate(startedAt))}</div>
    ${record?.completedAt ? `<div class="field"><strong>Completed:</strong> ${escapeHtml(formatDate(record.completedAt))}</div>` : ''}
  </div>

  ${liveSessionSection}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const feedEl = document.getElementById('activity-feed');
    const stateBadgeEl = document.getElementById('state-badge');
    const statusLabelEl = document.getElementById('status-label');
    const stepCounterEl = document.getElementById('step-counter');
    const abortBtn = document.getElementById('abort-btn');
    const inputArea = document.getElementById('input-area');
    const permArea = document.getElementById('permission-area');
    const sendBtn = document.getElementById('send-input');
    const textarea = document.getElementById('user-response');

    const stateLabels = ${JSON.stringify(STATE_LABELS).replace(/</g, '\\u003c')};
    const eventIcons = ${JSON.stringify(EVENT_ICONS).replace(/</g, '\\u003c')};
    const maxSteps = ${maxSteps};
    let knownEventCount = ${Number(record?.events.length ?? 0)};

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
      return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
    }

    const terminalStates = new Set(['completed', 'failed', 'aborted']);

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type !== 'update' || !msg.hasAgentSession) {
        return;
      }

      const info = stateLabels[msg.state] || { label: msg.state, icon: '❔' };
      stateBadgeEl.textContent = info.icon + ' ' + info.label;
      if (statusLabelEl) {
        statusLabelEl.textContent = info.label;
      }
      if (stepCounterEl) {
        stepCounterEl.textContent = 'Steps: ' + (msg.stepCount || 0) + '/' + maxSteps;
      }
      if (abortBtn) {
        abortBtn.disabled = terminalStates.has(msg.state);
      }

      if (msg.planText) {
        const planSection = document.getElementById('plan-section');
        if (planSection) {
          planSection.style.display = '';
        }
        const planContent = document.getElementById('plan-content');
        if (planContent) {
          planContent.textContent = msg.planText;
        }
      }

      if (feedEl && msg.events && msg.events.length > knownEventCount) {
        const newEvents = msg.events.slice(knownEventCount);
        feedEl.insertAdjacentHTML('beforeend', newEvents.map(renderEventRow).join(''));
        knownEventCount = msg.events.length;
        feedEl.scrollTop = feedEl.scrollHeight;
      }

      if (inputArea) {
        inputArea.classList.toggle('visible', msg.state === 'awaiting_input');
      }
      if (permArea) {
        permArea.classList.toggle('visible', msg.state === 'awaiting_approval');
      }
    });

    if (abortBtn) {
      abortBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'abort' });
      });
    }

    if (sendBtn && textarea) {
      sendBtn.addEventListener('click', () => {
        const response = textarea.value.trim();
        if (response) {
          vscode.postMessage({ type: 'respondInput', response });
          textarea.value = '';
        }
      });
    }

    const approveOnce = document.getElementById('approve-once');
    if (approveOnce) {
      approveOnce.addEventListener('click', () => {
        vscode.postMessage({ type: 'respondPermission', decision: 'allow_once' });
      });
    }
    const approveAlways = document.getElementById('approve-always');
    if (approveAlways) {
      approveAlways.addEventListener('click', () => {
        vscode.postMessage({ type: 'respondPermission', decision: 'allow_always' });
      });
    }
    const denyPerm = document.getElementById('deny-perm');
    if (denyPerm) {
      denyPerm.addEventListener('click', () => {
        vscode.postMessage({ type: 'respondPermission', decision: 'deny' });
      });
    }

    if (feedEl) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  </script>
</body>
</html>`;
  }

  private renderEvents(events: AgentEventSummary[]): string {
    return events
      .map(event => {
        const icon = EVENT_ICONS[event.type] ?? '•';
        const time = this.formatTime(event.timestamp);
        return `<div class="event-row">
          <span class="event-icon">${icon}</span>
          <span class="event-time">${escapeHtml(time)}</span>
          <span class="event-summary">${escapeHtml(event.summary)}</span>
        </div>`;
      })
      .join('');
  }

  private formatTime(timestamp: string): string {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return '';
    }
  }

  private isTerminal(state: string): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }
}
