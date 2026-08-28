import * as vscode from 'vscode';
import type { AiSessionManager } from '@praxis/core';
import type { PermissionInfo } from '@praxis/core';
import { AGENT_DEFAULTS, type AgentSessionRecord, type AgentEventSummary } from '@praxis/core';
import type { AiAssignment, AiProvider } from '@praxis/core';

export interface AgentSessionController {
  onDidChangeActiveTask(listener: (issueKey: string) => void): () => void;
  respondToInput(issueKey: string, response: string): void;
  respondToPermission(
    issueKey: string,
    decision: 'allow_once' | 'allow_always' | 'deny'
  ): void;
  hasActiveTask(issueKey: string): boolean;
  getPendingPermissionDescriptions(issueKey: string): string[];
  getPendingPermissions(issueKey: string): PermissionInfo[];
}

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
  'vercel-gateway': 'Vercel AI Gateway',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'claude-code-cli': 'Claude Code CLI',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'GitHub Copilot CLI'
};

const STATE_LABELS: Record<string, { label: string; icon: string }> = {
  'not_started': { label: 'Not Started', icon: '⏳' },
  'planning': { label: 'Planning', icon: '📋' },
  'awaiting_approval': { label: 'Awaiting Approval', icon: '⚠️' },
  'executing': { label: 'Executing', icon: '⚙️' },
  'awaiting_input': { label: 'Awaiting Input', icon: '❓' },
  'paused': { label: 'Paused', icon: '⏸️' },
  'completed': { label: 'Completed', icon: '✅' },
  'failed': { label: 'Failed', icon: '❌' },
  'aborted': { label: 'Aborted', icon: '🛑' },
  active: { label: 'Assigned', icon: '🤖' }
};

const EVENT_ICONS: Record<string, string> = {
  'session_start': '🚀',
  'intent': '🎯',
  'reasoning': '🧠',
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
  if (record?.provider) {
    return PROVIDER_LABELS[record.provider] ?? record.provider;
  }
  if (record) {
    return PROVIDER_LABELS['vercel-gateway'];
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
  return STATE_LABELS['not_started'];
}

function findLatestEventSummary(
  record: AgentSessionRecord | undefined,
  eventType: string
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event.type === eventType) {
      return event.summary;
    }
  }
  return undefined;
}

function getQueuedPermissionLabel(count: number): string | undefined {
  const additionalCount = Math.max(0, count - 1);
  if (additionalCount === 0) {
    return undefined;
  }
  return `${additionalCount} more queued request${additionalCount === 1 ? '' : 's'}.`;
}

function resolvePermissionDescription(
  record: AgentSessionRecord | undefined,
  pendingDescriptions: string[]
): string {
  return pendingDescriptions[0]
    ?? findLatestEventSummary(record, 'permission_requested')
    ?? 'The agent is requesting permission to proceed.';
}

/** Categories used for feed filtering. "verbose" events are hidden by default. */
function eventCategory(type: string): string {
  switch (type) {
    case 'tool_start':
    case 'tool_complete':
      return 'tool';
    case 'permission_requested':
    case 'permission_completed':
    case 'user_input_requested':
    case 'user_input_completed':
    case 'idle':
      return 'system';
    case 'message':
    case 'intent':
    case 'plan':
    case 'reasoning':
      return 'message';
    case 'error':
    case 'warning':
    case 'aborted':
      return 'error';
    default:
      return 'other';
  }
}

/** Categories that are only shown when verbose mode is on. */
const VERBOSE_CATEGORIES = new Set(['tool', 'system']);

const PERMISSION_KIND_META: Record<string, { icon: string; label: string; variant: string }> = {
  read:   { icon: '📖', label: 'Read File',     variant: 'info' },
  write:  { icon: '✏️', label: 'Write File',    variant: 'warning' },
  shell:  { icon: '⚡', label: 'Run Command',   variant: 'error' },
  mcp:    { icon: '🔌', label: 'MCP Tool',      variant: 'info' },
  'custom-tool': { icon: '🔧', label: 'Custom Tool', variant: 'info' },
  url:    { icon: '🌐', label: 'Fetch URL',     variant: 'info' }
};

function getPermissionMeta(kind: string): { icon: string; label: string; variant: string } {
  return PERMISSION_KIND_META[kind] ?? { icon: '🔒', label: 'Permission', variant: 'warning' };
}

/** Manages one webview panel per AI session. */
export class CopilotSessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private disposables: vscode.Disposable[] = [];
  private recreationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly sessionManager: AiSessionManager,
    private readonly agentService: AgentSessionController,
    private readonly onAbandonSession: (issueKey: string) => Promise<void>,
    private readonly onResumeSession: (issueKey: string) => Promise<void>,
    private readonly onStartNewSession: (issueKey: string) => Promise<void>
  ) {
    const disposeActiveTaskListener = this.agentService.onDidChangeActiveTask(issueKey => {
      if (this.panels.has(issueKey)) {
        this.scheduleRecreation(issueKey);
      }
    });
    this.disposables.push(
      new vscode.Disposable(() => {
        disposeActiveTaskListener();
      }),
      this.sessionManager.onDidChangeSession(({ issueKey }) => {
        if (this.panels.has(issueKey)) {
          this.scheduleRecreation(issueKey);
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
      // Dispose and recreate — VS Code Insiders requires webview.html
      // to be set synchronously after panel creation for scripts to work.
      this.recreatePanel(issueKey);
      return;
    }

    this.createPanel(issueKey);
  }

  public dispose(): void {
    for (const timer of this.recreationTimers.values()) {
      clearTimeout(timer);
    }
    this.recreationTimers.clear();
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
      case 'resumeSession': {
        await this.onResumeSession(issueKey);
        break;
      }
      case 'startNewSession': {
        await this.onStartNewSession(issueKey);
        break;
      }
    }
  }

  private updatePanel(panel: vscode.WebviewPanel, issueKey: string): void {
    const assignment = this.sessionManager.getSession(issueKey);
    const record = this.sessionManager.getAgentSession(issueKey);
    const hasLiveAgentSession = this.agentService.hasActiveTask(issueKey);
    if (!assignment && !record) {
      this.recreatePanel(issueKey);
      return;
    }
    if (!record) {
      this.recreatePanel(issueKey);
      return;
    }

    panel.webview.postMessage({
      type: 'update',
      state: record.state,
      events: record.events,
      planText: record.planText,
      reasoningText: record.reasoningText,
      responseText: record.responseText,
      permissionDescriptions: this.agentService.getPendingPermissionDescriptions(issueKey),
      permissions: this.agentService.getPendingPermissions(issueKey),
      stepCount: record.stepCount,
      hasAgentSession: hasLiveAgentSession
    });
  }

  /** Create a new panel and set html synchronously. */
  private createPanel(issueKey: string): void {
    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.aiSession',
      `🤖 AI Session: ${issueKey}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // Attach message handler BEFORE setting html so no messages are lost
    // once the webview script starts executing.
    panel.webview.onDidReceiveMessage(message => {
      this.handleMessage(issueKey, message).catch(error => {
        console.error('[CopilotSessionPanel] message handler error:', error);
      });
    });

    panel.webview.html = this.getHtml(
      nonce,
      issueKey,
      this.sessionManager.getSession(issueKey),
      this.sessionManager.getAgentSession(issueKey)
    );

    this.panels.set(issueKey, panel);
    panel.onDidDispose(() => {
      this.panels.delete(issueKey);
    });
  }

  /** Dispose existing panel and create a fresh one. */
  private recreatePanel(issueKey: string): void {
    // Cancel any pending debounced recreation so we don't recreate twice.
    const timer = this.recreationTimers.get(issueKey);
    if (timer) {
      clearTimeout(timer);
      this.recreationTimers.delete(issueKey);
    }

    const old = this.panels.get(issueKey);
    if (old) {
      this.panels.delete(issueKey);
      old.dispose();
    }
    this.createPanel(issueKey);
  }

  /**
   * Debounce event-driven recreation — multiple events (activeTask, session)
   * often fire in quick succession for the same issue.  Coalescing them into
   * a single recreation prevents rapid dispose-create cycles that can leave
   * VS Code Insiders with an uninitialised webview.
   */
  private scheduleRecreation(issueKey: string): void {
    const existing = this.recreationTimers.get(issueKey);
    if (existing) {
      clearTimeout(existing);
    }
    this.recreationTimers.set(
      issueKey,
      setTimeout(() => {
        this.recreationTimers.delete(issueKey);
        if (this.panels.has(issueKey)) {
          this.recreatePanel(issueKey);
        }
      }, 200)
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
    const hasLiveAgentSession = this.agentService.hasActiveTask(issueKey);
    const supportsAgentSession = Boolean(record) || assignment?.provider === 'vercel-gateway';
    const maxSteps = Number(task?.maxSteps ?? AGENT_DEFAULTS.maxSteps);
    const isTerminal = record ? this.isTerminal(record.state) : assignment?.status !== 'active';
    const badgeVariant = this.resolveBadgeVariant(record?.state ?? assignment?.status);
    const pendingPermissionDescriptions = hasLiveAgentSession
      ? this.agentService.getPendingPermissionDescriptions(issueKey)
      : [];
    const pendingPermissions: PermissionInfo[] = hasLiveAgentSession
      ? this.agentService.getPendingPermissions(issueKey)
      : [];
    const permissionDescription = resolvePermissionDescription(record, pendingPermissionDescriptions);
    const queuedPermissionLabel = getQueuedPermissionLabel(pendingPermissionDescriptions.length);
    const currentPermission = pendingPermissions[0];

    const verboseFeed = vscode.workspace.getConfiguration('ticketManager.ai').get<boolean>('verboseActivityFeed', false);
    const stepCount = record?.stepCount ?? 0;
    const progressPct = maxSteps > 0 ? Math.min(100, Math.round((stepCount / maxSteps) * 100)) : 0;
    const latestEvent = record?.events.length ? record.events[record.events.length - 1] : undefined;
    const currentActionText = latestEvent?.summary ?? statusInfo.label;
    const currentActionIcon = latestEvent ? (EVENT_ICONS[latestEvent.type] ?? '•') : statusInfo.icon;
    const activityFeed = record ? this.renderEvents(record.events, verboseFeed) : '';

    // ── Live tab ──────────────────────────────────────────────────────────
    let liveTabContent: string;
    if (record) {
      let statusCard = '';
      if (!hasLiveAgentSession) {
        if (isTerminal) {
          statusCard = `<div class="card card--${badgeVariant}"><h3>${escapeHtml(statusInfo.icon)} Session ${escapeHtml(statusInfo.label)}</h3><div class="field">This session has ended. You can review the activity below or start a new session.</div></div>`;
        } else {
          statusCard = `<div class="card"><h3>Session paused</h3><div class="field">This session is not currently connected to a live agent stream. You can review the saved activity below or resume the session to continue in real time.</div></div>`;
        }
      }

      liveTabContent = `
        ${statusCard}

        <div id="current-action" class="current-action ${hasLiveAgentSession ? '' : 'hidden'}">
          <span id="current-action-icon" class="current-action-icon">${currentActionIcon}</span>
          <span id="current-action-text">${escapeHtml(currentActionText)}</span>
        </div>

        <div id="progress-area" class="progress-area ${hasLiveAgentSession ? '' : 'hidden'}">
          <div class="progress-bar">
            <div class="progress-fill" id="progress-fill" style="width: ${progressPct}%"></div>
          </div>
          <span class="progress-label" id="progress-label">${stepCount} / ${maxSteps} steps</span>
        </div>

        <div id="permission-area" class="perm-card ${hasLiveAgentSession && record.state === 'awaiting_approval' ? 'visible' : ''}" role="alert" aria-live="assertive">
          <div class="perm-card-header">
            <span id="perm-kind-badge" class="perm-kind-badge perm-kind--${currentPermission ? getPermissionMeta(currentPermission.kind).variant : 'warning'}">
              <span id="perm-kind-icon" class="perm-kind-icon">${currentPermission ? getPermissionMeta(currentPermission.kind).icon : '🔒'}</span>
              <span id="perm-kind-label">${currentPermission ? escapeHtml(getPermissionMeta(currentPermission.kind).label) : 'Permission'}</span>
            </span>
            <span class="perm-title">Permission Required</span>
          </div>
          ${currentPermission?.detail ? `<div id="perm-detail-block" class="perm-detail-block"><code id="perm-detail-text">${escapeHtml(currentPermission.detail)}</code></div>` : `<div id="perm-detail-block" class="perm-detail-block" style="display:none"><code id="perm-detail-text"></code></div>`}
          <p id="permission-desc" class="perm-desc">${escapeHtml(permissionDescription)}</p>
          <div id="permission-queue" class="perm-queue" style="${queuedPermissionLabel ? '' : 'display:none'}">${escapeHtml(queuedPermissionLabel ?? '')}</div>
          <div class="perm-actions">
            <button id="approve-once" class="perm-btn perm-btn--approve">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
              Approve Once
            </button>
            <button id="approve-always" class="perm-btn perm-btn--approve-all">
              <svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
              Approve All
            </button>
            <button id="deny-perm" class="perm-btn perm-btn--deny">
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              Deny
            </button>
          </div>
        </div>

        <div class="feed-section">
          <div class="feed-header">
            <h3>Activity Feed</h3>
            <label class="auto-scroll-toggle"><input type="checkbox" id="auto-scroll-toggle" checked /> Auto-scroll</label>
            <div class="feed-filters">
              <button class="filter-btn active" data-filter="message">Messages</button>
              <button class="filter-btn" data-filter="error">Errors</button>
              ${verboseFeed ? `<button class="filter-btn" data-filter="tool">Tools</button>
              <button class="filter-btn" data-filter="system">System</button>` : ''}
              <button class="filter-btn" data-filter="all">All</button>
            </div>
          </div>
          <div id="activity-feed">${activityFeed}</div>
        </div>

        <div id="input-area" class="input-area ${hasLiveAgentSession && record.state === 'awaiting_input' ? 'visible' : ''}">
          <h3>Agent input requested</h3>
          <textarea id="user-response" placeholder="Type your response..."></textarea>
          <div class="btn-row">
            <button id="send-input" class="btn">Send</button>
          </div>
        </div>`;
    } else {
      const noSessionMessage = !assignment && !record
        ? 'No AI session has been started for this ticket yet. Start a new session to begin.'
        : supportsAgentSession
          ? 'This ticket is assigned to AI, but no live session is currently attached. Start a new session to see real-time details here.'
          : `This ticket is assigned to ${escapeHtml(assignmentLabel)}, but live streaming session details are currently available only for CLI-backed agent sessions.`;
      liveTabContent = `
        <div class="card">
          <h3>${!assignment && !record ? 'No AI session' : supportsAgentSession ? 'No live agent activity yet' : 'Assignment-only session'}</h3>
          <div class="field">${noSessionMessage}</div>
          <div class="btn-row"><button id="empty-start-new-btn" class="btn btn-primary" title="Start New Session"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Start New Session</button></div>
        </div>`;
    }

    // ── Plan & Reasoning tab ─────────────────────────────────────────────
    let planTabContent: string;
    if (record) {
      planTabContent = `
        <details class="card" open>
          <summary>Task Definition</summary>
          <div class="field"><strong>Goal:</strong> ${escapeHtml(task?.goal ?? '—')}</div>
          <div class="field"><strong>Scope:</strong> ${escapeHtml(task?.scope ?? '—')}</div>
          <div class="field"><strong>Done when:</strong> ${escapeHtml(task?.definitionOfDone ?? '—')}</div>
          ${task?.nonGoals?.length ? `<div class="field"><strong>Non-goals:</strong> ${task.nonGoals.map(goal => escapeHtml(goal)).join(', ')}</div>` : ''}
        </details>

        <div id="plan-section" class="plan-section" style="${record.planText ? '' : 'display:none'}">
          <h3>Plan</h3>
          <div id="plan-content" class="plan-content">${record.planText ? escapeHtml(record.planText) : ''}</div>
        </div>

        <div id="reasoning-section" class="plan-section" style="${record.reasoningText ? '' : 'display:none'}">
          <h3>Thinking / Reasoning</h3>
          <div id="reasoning-content" class="plan-content">${record.reasoningText ? escapeHtml(record.reasoningText) : ''}</div>
        </div>

        <details class="card">
          <summary>Session Details</summary>
          <div class="field"><strong>Agent:</strong> <span id="agent-label">${escapeHtml(assignmentLabel)}</span></div>
          <div class="field"><strong>Session ID:</strong> ${escapeHtml(sessionId)}</div>
          <div class="field"><strong>Status:</strong> <span id="status-label">${escapeHtml(statusInfo.label)}</span></div>
          <div class="field"><strong>Started:</strong> ${escapeHtml(formatDate(startedAt))}</div>
          ${record.completedAt ? `<div class="field"><strong>Completed:</strong> ${escapeHtml(formatDate(record.completedAt))}</div>` : ''}
        </details>`;
    } else {
      planTabContent = `
        <div class="card">
          <h3>No session data</h3>
          <div class="field">Plan and reasoning details will appear here once an agent session is active.</div>
        </div>`;
    }

    // ── Output tab ───────────────────────────────────────────────────────
    let outputTabContent: string;
    if (record) {
      const hasResponse = Boolean(record.responseText);
      const terminalLabel = isTerminal
        ? `<div class="output-status">
            <span id="output-state-badge" class="state-badge state-badge--${badgeVariant}" data-variant="${badgeVariant}"><span class="badge-dot"></span> ${escapeHtml(statusInfo.label)}</span>
          </div>`
        : '';

      outputTabContent = `
        ${terminalLabel}
        <div id="response-section" class="plan-section" style="${hasResponse ? '' : 'display:none'}">
          <h3>Assistant Response</h3>
          <div id="response-content" class="plan-content">${record.responseText ? escapeHtml(record.responseText) : ''}</div>
        </div>
        ${!hasResponse && !isTerminal ? `<div class="card"><h3>Waiting for output</h3><div class="field">The assistant's response will appear here once available.</div></div>` : ''}
        ${!hasResponse && isTerminal ? `<div class="card"><h3>No output</h3><div class="field">The session ended without producing a response.</div></div>` : ''}`;
    } else {
      outputTabContent = `
        <div class="card">
          <h3>No output yet</h3>
          <div class="field">Agent output will appear here once a session has run.</div>
        </div>`;
    }

    // Default active tab — always Live (permission area auto-switches via JS)
    const defaultTab = 'live' as string;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Session: ${escapeHtml(issueKey)}</title>
  <style>
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
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    h2, h3 { margin: 0 0 8px; }

    /* ── Header ──────────────────────────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 0;
      flex-shrink: 0;
    }
    .header-main {
      flex: 1;
      min-width: 0;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .header-actions .actions-divider {
      width: 1px;
      height: 20px;
      background: var(--border);
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

    /* ── Badge ────────────────────────────────────────────────────── */
    .state-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }
    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .state-badge--active   { background: rgba(74,222,128,0.1);  color: #4ade80; border: 1px solid rgba(74,222,128,0.2); }
    .state-badge--active  .badge-dot { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
    .state-badge--warning  { background: rgba(250,204,21,0.1);  color: #fde68a; border: 1px solid rgba(250,204,21,0.2); }
    .state-badge--warning .badge-dot { background: #facc15; box-shadow: 0 0 6px #facc15; }
    .state-badge--error    { background: rgba(239,68,68,0.1);   color: #fca5a5; border: 1px solid rgba(239,68,68,0.2); }
    .state-badge--error   .badge-dot { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
    .state-badge--neutral  { background: rgba(161,161,170,0.1); color: #a1a1aa; border: 1px solid rgba(161,161,170,0.2); }
    .state-badge--neutral .badge-dot { background: #a1a1aa; box-shadow: 0 0 6px #a1a1aa; }
    .state-badge--info     { background: rgba(96,165,250,0.1);  color: #93c5fd; border: 1px solid rgba(96,165,250,0.2); }
    .state-badge--info    .badge-dot { background: #60a5fa; box-shadow: 0 0 6px #60a5fa; }

    /* ── Tabs ─────────────────────────────────────────────────────── */
    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
      flex-shrink: 0;
    }
    .tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 16px;
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .tab:hover {
      color: var(--fg);
    }
    .tab.active {
      color: var(--fg);
      border-bottom-color: var(--vscode-textLink-foreground, #60a5fa);
    }
    .tab-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-textLink-foreground, #60a5fa);
      display: none;
    }
    .tab-panel {
      display: none;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .tab-panel.active {
      display: flex;
    }

    /* ── Progress bar ─────────────────────────────────────────────── */
    .progress-area {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .progress-area.hidden { display: none; }
    .progress-bar {
      flex: 1;
      height: 6px;
      background: color-mix(in srgb, var(--border) 60%, transparent);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--vscode-textLink-foreground, #60a5fa);
      transition: width 0.3s ease;
    }
    .progress-label {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      min-width: 80px;
      text-align: right;
    }

    /* ── Current action banner ────────────────────────────────────── */
    .current-action {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 12px;
      font-size: 12px;
      color: var(--muted);
      background: color-mix(in srgb, var(--input-bg) 50%, transparent);
    }
    .current-action.hidden { display: none; }
    .current-action-icon { flex-shrink: 0; }

    /* ── Cards ─────────────────────────────────────────────────────── */
    .card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .card--info    { border-color: rgba(96,165,250,0.3);  background: rgba(96,165,250,0.04); }
    .card--error   { border-color: rgba(239,68,68,0.3);  background: rgba(239,68,68,0.04); }
    .card--active  { border-color: rgba(74,222,128,0.3); background: rgba(74,222,128,0.04); }
    .card--warning { border-color: rgba(250,204,21,0.3); background: rgba(250,204,21,0.04); }
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

    /* ── Plan/Reasoning/Response sections ──────────────────────────── */
    .plan-section { margin-bottom: 16px; }
    .plan-content {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 300px;
      overflow-y: auto;
    }

    /* ── Activity feed ─────────────────────────────────────────────── */
    .feed-section {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      margin-bottom: 16px;
    }
    .feed-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .feed-header h3 { margin: 0; }
    .auto-scroll-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--muted);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .auto-scroll-toggle input {
      cursor: pointer;
      accent-color: var(--accent, #007acc);
    }
    .feed-filters {
      display: flex;
      gap: 4px;
    }
    .filter-btn {
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover {
      color: var(--fg);
      border-color: color-mix(in srgb, var(--fg) 30%, var(--border));
    }
    .filter-btn.active {
      color: var(--fg);
      background: color-mix(in srgb, var(--vscode-textLink-foreground, #60a5fa) 15%, transparent);
      border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #60a5fa) 40%, transparent);
    }
    #activity-feed {
      border: 1px solid var(--border);
      border-radius: 6px;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px;
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
    .event-row.filtered-out { display: none; }
    .event-icon { flex-shrink: 0; width: 20px; text-align: center; }
    .event-time { flex-shrink: 0; color: var(--muted); min-width: 65px; }
    .event-summary { flex: 1; word-break: break-word; }
    .event-detail {
      margin-top: 4px;
      color: var(--muted);
      white-space: pre-wrap;
    }

    /* ── Input area ─────────────────────────────────────────────────── */
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

    /* ── Permission card ──────────────────────────────────────────── */
    .perm-card {
      display: none;
      flex-direction: column;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 5;
      margin-bottom: 14px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--vscode-sideBar-background, var(--bg));
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(255,255,255,0.04) inset;
    }
    .perm-card.visible { display: flex; }
    .perm-card-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .perm-title {
      font-size: 14px;
      font-weight: 600;
    }
    .perm-kind-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .perm-kind-icon { font-size: 13px; }
    .perm-kind--info {
      background: rgba(96,165,250,0.1);
      color: #93c5fd;
      border: 1px solid rgba(96,165,250,0.2);
    }
    .perm-kind--warning {
      background: rgba(250,204,21,0.1);
      color: #fde68a;
      border: 1px solid rgba(250,204,21,0.2);
    }
    .perm-kind--error {
      background: rgba(239,68,68,0.1);
      color: #fca5a5;
      border: 1px solid rgba(239,68,68,0.2);
    }
    .perm-detail-block {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
    }
    .perm-detail-block code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      color: var(--fg);
      word-break: break-all;
      white-space: pre-wrap;
    }
    .perm-desc {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
    }
    .perm-queue {
      font-size: 11px;
      font-weight: 500;
      color: var(--muted);
      padding: 4px 0 0;
    }
    .perm-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding-top: 2px;
    }
    .perm-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      background: transparent;
      color: #d4d4d8;
      transition: all 0.15s ease;
    }
    .perm-btn svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      flex-shrink: 0;
    }
    .perm-btn--approve {
      color: #4ade80;
      border-color: rgba(74,222,128,0.25);
      background: rgba(74,222,128,0.06);
    }
    .perm-btn--approve:hover {
      background: rgba(74,222,128,0.14);
      border-color: rgba(74,222,128,0.4);
      color: #86efac;
    }
    .perm-btn--approve-all {
      color: #60a5fa;
      border-color: rgba(96,165,250,0.25);
      background: rgba(96,165,250,0.06);
    }
    .perm-btn--approve-all:hover {
      background: rgba(96,165,250,0.14);
      border-color: rgba(96,165,250,0.4);
      color: #93c5fd;
    }
    .perm-btn--deny {
      color: #ef4444;
      border-color: transparent;
    }
    .perm-btn--deny:hover {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.3);
      color: #fca5a5;
    }

    /* ── Output status ────────────────────────────────────────────── */
    .output-status {
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Buttons ──────────────────────────────────────────────────── */
    .btn-row {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      font-family: inherit;
      background: transparent;
      color: #d4d4d8;
      transition: all 0.15s ease;
    }
    .btn svg {
      width: 15px;
      height: 15px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      flex-shrink: 0;
    }
    .btn:hover {
      background: #27272a;
      color: var(--fg);
      border-color: #3f3f46;
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }
    .btn-success {
      color: #4ade80;
      border-color: transparent;
    }
    .btn-success:hover {
      background: rgba(74,222,128,0.08);
      border-color: rgba(74,222,128,0.3);
      color: #86efac;
    }
    .btn-primary {
      color: #60a5fa;
      border-color: transparent;
    }
    .btn-primary:hover {
      background: rgba(96,165,250,0.08);
      border-color: rgba(96,165,250,0.3);
      color: #93c5fd;
    }
    .btn-danger {
      color: #ef4444;
      border-color: transparent;
    }
    .btn-danger:hover {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.3);
      color: #fca5a5;
    }
    .btn-secondary {
      color: #d4d4d8;
      border-color: var(--border);
    }
    .btn-secondary:hover {
      background: #27272a;
      border-color: #3f3f46;
      color: var(--fg);
    }
    .btn-deny {
      color: #ef4444;
      border-color: transparent;
    }
    .btn-deny:hover {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.3);
      color: #fca5a5;
    }
    .attention-queue {
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .step-counter {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    /* ── Icon-only header buttons ─────────────────────────────────── */
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border-radius: 7px;
      cursor: pointer;
      background: transparent;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .icon-btn svg {
      width: 15px;
      height: 15px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }
    .icon-btn:disabled {
      opacity: 0.3;
      cursor: default;
      pointer-events: none;
    }
    .icon-btn--success {
      color: #4ade80;
      border: 1px solid rgba(74,222,128,0.35);
    }
    .icon-btn--success:hover {
      background: rgba(74,222,128,0.1);
      border-color: rgba(74,222,128,0.5);
    }
    .icon-btn--primary {
      color: #60a5fa;
      border: 1px solid rgba(96,165,250,0.35);
    }
    .icon-btn--primary:hover {
      background: rgba(96,165,250,0.1);
      border-color: rgba(96,165,250,0.5);
    }
    .icon-btn--danger {
      color: #ef4444;
      border: 1px solid rgba(239,68,68,0.35);
    }
    .icon-btn--danger:hover {
      background: rgba(239,68,68,0.1);
      border-color: rgba(239,68,68,0.5);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-main">
      <div class="header-title">🤖 ${escapeHtml(issueKey)}</div>
      <div class="header-meta">${escapeHtml(assignmentLabel)} • Session ${escapeHtml(sessionId.slice(0, 8))}</div>
    </div>
    <span id="state-badge" class="state-badge state-badge--${badgeVariant}" data-variant="${badgeVariant}"><span class="badge-dot"></span> ${escapeHtml(statusInfo.label)}</span>
    <span id="step-counter" class="step-counter">${hasLiveAgentSession ? `Steps: ${stepCount}/${maxSteps}` : `Assigned: ${escapeHtml(formatDate(startedAt))}`}</span>
    <div class="header-actions">
      ${record && !hasLiveAgentSession && !isTerminal ? `<button id="resume-btn" class="icon-btn icon-btn--success" title="Resume Session"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button>` : ''}
      ${supportsAgentSession ? `<button id="start-new-btn" class="icon-btn icon-btn--primary" title="Start New Session"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>` : ''}
      <button id="abort-btn" class="icon-btn icon-btn--danger" ${isTerminal ? 'disabled' : ''} title="Abandon Session"><svg viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
    </div>
  </div>

  <div class="tab-bar">
    <button class="tab ${defaultTab === 'live' ? 'active' : ''}" data-tab="live">⚡ Live <span class="tab-dot" id="tab-dot-live"></span></button>
    <button class="tab ${defaultTab === 'plan' ? 'active' : ''}" data-tab="plan">📋 Plan &amp; Reasoning <span class="tab-dot" id="tab-dot-plan"></span></button>
    <button class="tab ${defaultTab === 'output' ? 'active' : ''}" data-tab="output">📄 Output <span class="tab-dot" id="tab-dot-output"></span></button>
  </div>

  <div class="tab-panel ${defaultTab === 'live' ? 'active' : ''}" id="tab-live">
    ${liveTabContent}
  </div>

  <div class="tab-panel ${defaultTab === 'plan' ? 'active' : ''}" id="tab-plan">
    ${planTabContent}
  </div>

  <div class="tab-panel ${defaultTab === 'output' ? 'active' : ''}" id="tab-output">
    ${outputTabContent}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let activeTab = '${defaultTab}';

    // ── DOM refs ──────────────────────────────────────────────────
    const feedEl = document.getElementById('activity-feed');
    const stateBadgeEl = document.getElementById('state-badge');
    const statusLabelEl = document.getElementById('status-label');
    const stepCounterEl = document.getElementById('step-counter');
    const abortBtn = document.getElementById('abort-btn');
    const resumeBtn = document.getElementById('resume-btn');
    const startNewBtn = document.getElementById('start-new-btn');
    const emptyStartNewBtn = document.getElementById('empty-start-new-btn');
    const reasoningSectionEl = document.getElementById('reasoning-section');
    const reasoningContentEl = document.getElementById('reasoning-content');
    const responseSectionEl = document.getElementById('response-section');
    const responseContentEl = document.getElementById('response-content');
    const inputArea = document.getElementById('input-area');
    const permArea = document.getElementById('permission-area');
    const permissionDescEl = document.getElementById('permission-desc');
    const permissionQueueEl = document.getElementById('permission-queue');
    const permKindBadge = document.getElementById('perm-kind-badge');
    const permKindIcon = document.getElementById('perm-kind-icon');
    const permKindLabel = document.getElementById('perm-kind-label');
    const permDetailBlock = document.getElementById('perm-detail-block');
    const permDetailText = document.getElementById('perm-detail-text');
    const sendBtn = document.getElementById('send-input');
    const textarea = document.getElementById('user-response');
    const progressFill = document.getElementById('progress-fill');
    const progressLabel = document.getElementById('progress-label');
    const progressArea = document.getElementById('progress-area');
    const currentActionEl = document.getElementById('current-action');
    const currentActionIconEl = document.getElementById('current-action-icon');
    const currentActionTextEl = document.getElementById('current-action-text');

    const stateLabels = ${JSON.stringify(STATE_LABELS).replace(/</g, '\\u003c')};
    const eventIcons = ${JSON.stringify(EVENT_ICONS).replace(/</g, '\\u003c')};
    const maxSteps = ${maxSteps};
    let knownEventCount = ${Number(record?.events.length ?? 0)};
    let permissionSignature = ${JSON.stringify(pendingPermissionDescriptions.join('\n')).replace(/</g, '\\u003c')};
    let currentFilter = 'message';
    let autoScroll = true;
    var autoScrollToggle = document.getElementById('auto-scroll-toggle');
    if (autoScrollToggle) {
      autoScrollToggle.addEventListener('change', function() { autoScroll = this.checked; });
    }
    const verboseMode = ${verboseFeed ? 'true' : 'false'};
    const verboseCategories = { tool: true, system: true };

    const permKindMeta = ${JSON.stringify(PERMISSION_KIND_META).replace(/</g, '\\u003c')};
    var defaultPermMeta = { icon: '🔒', label: 'Permission', variant: 'warning' };

    function getPermMeta(kind) {
      return permKindMeta[kind] || defaultPermMeta;
    }

    // ── Tab switching ─────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(function(tabBtn) {
      tabBtn.addEventListener('click', function() {
        const tabName = this.dataset.tab;
        if (tabName === activeTab) return;
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        this.classList.add('active');
        var panel = document.getElementById('tab-' + tabName);
        if (panel) panel.classList.add('active');
        activeTab = tabName;
        // Clear notification dot on this tab
        var dot = document.getElementById('tab-dot-' + tabName);
        if (dot) dot.style.display = 'none';
      });
    });

    // ── Feed filters ──────────────────────────────────────────────
    const eventCategories = {
      tool_start: 'tool', tool_complete: 'tool',
      permission_requested: 'system', permission_completed: 'system',
      user_input_requested: 'system', user_input_completed: 'system',
      idle: 'system',
      message: 'message', intent: 'message', plan: 'message', reasoning: 'message',
      error: 'error', warning: 'error', aborted: 'error'
    };

    function applyFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      if (!feedEl) return;
      feedEl.querySelectorAll('.event-row').forEach(function(row) {
        var cat = row.dataset.category || 'other';
        if (filter === 'all') {
          // In non-verbose mode, hide tool/system events even with "All" filter
          row.classList.toggle('filtered-out', !verboseMode && verboseCategories[cat]);
        } else {
          row.classList.toggle('filtered-out', cat !== filter);
        }
      });
    }

    document.querySelectorAll('.filter-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        applyFilter(this.dataset.filter);
      });
    });

    // ── Helpers ───────────────────────────────────────────────────
    function formatTime(ts) {
      try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
      catch { return ''; }
    }

    function renderEventRow(ev) {
      var icon = eventIcons[ev.type] || '•';
      var cat = eventCategories[ev.type] || 'other';
      var hiddenByFilter = currentFilter !== 'all' && cat !== currentFilter;
      var hiddenByVerbose = currentFilter === 'all' && !verboseMode && verboseCategories[cat];
      var hidden = (hiddenByFilter || hiddenByVerbose) ? ' filtered-out' : '';
      var detail = ev.detail
        ? '<div class="event-detail">' + escapeHtml(ev.detail) + '</div>'
        : '';
      return '<div class="event-row' + hidden + '" data-category="' + cat + '">'
        + '<span class="event-icon">' + icon + '</span>'
        + '<span class="event-time">' + formatTime(ev.timestamp) + '</span>'
        + '<span class="event-summary">' + escapeHtml(ev.summary) + detail + '</span>'
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

    function showTabDot(tabName) {
      if (tabName === activeTab) return;
      var dot = document.getElementById('tab-dot-' + tabName);
      if (dot) dot.style.display = '';
    }

    const terminalStates = new Set(['completed', 'failed', 'aborted']);
    const badgeVariants = {
      executing: 'active', planning: 'active', active: 'active',
      awaiting_approval: 'warning', awaiting_input: 'warning', paused: 'warning',
      failed: 'error', aborted: 'error',
      completed: 'info'
    };

    function latestPermissionSummary(events) {
      if (!Array.isArray(events)) {
        return 'The agent is requesting permission to proceed.';
      }
      for (var index = events.length - 1; index >= 0; index -= 1) {
        var event = events[index];
        if (event && event.type === 'permission_requested' && typeof event.summary === 'string') {
          return event.summary;
        }
      }
      return 'The agent is requesting permission to proceed.';
    }

    function formatQueuedPermissionLabel(descriptions) {
      var count = Math.max(0, descriptions.length - 1);
      if (count === 0) {
        return '';
      }
      return count + ' more queued request' + (count === 1 ? '' : 's') + '.';
    }

    // ── Incremental update handler ────────────────────────────────
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type !== 'update' || !msg.hasAgentSession) {
        return;
      }

      // ── Header: badge + step counter ──
      var info = stateLabels[msg.state] || { label: msg.state, icon: '❔' };
      var variant = badgeVariants[msg.state] || 'neutral';
      var prevVariant = stateBadgeEl ? (stateBadgeEl.dataset.variant || 'neutral') : 'neutral';
      if (stateBadgeEl && prevVariant !== variant) {
        stateBadgeEl.classList.remove('state-badge--' + prevVariant);
        stateBadgeEl.classList.add('state-badge--' + variant);
        stateBadgeEl.dataset.variant = variant;
      }
      if (stateBadgeEl) {
        var dotEl = stateBadgeEl.querySelector('.badge-dot');
        if (dotEl) {
          stateBadgeEl.lastChild.textContent = ' ' + info.label;
        } else {
          stateBadgeEl.textContent = info.label;
        }
      }
      if (statusLabelEl) {
        statusLabelEl.textContent = info.label;
      }
      if (stepCounterEl) {
        stepCounterEl.textContent = 'Steps: ' + (msg.stepCount || 0) + '/' + maxSteps;
      }
      if (abortBtn) {
        abortBtn.disabled = terminalStates.has(msg.state);
      }

      // ── Output tab: update state badge if present ──
      var outputBadge = document.getElementById('output-state-badge');
      if (outputBadge) {
        var oPrev = outputBadge.dataset.variant || 'neutral';
        if (oPrev !== variant) {
          outputBadge.classList.remove('state-badge--' + oPrev);
          outputBadge.classList.add('state-badge--' + variant);
          outputBadge.dataset.variant = variant;
        }
        var oDot = outputBadge.querySelector('.badge-dot');
        if (oDot) {
          outputBadge.lastChild.textContent = ' ' + info.label;
        }
      }

      // ── Live tab: progress bar + current action ──
      if (progressFill) {
        var pct = maxSteps > 0 ? Math.min(100, Math.round(((msg.stepCount || 0) / maxSteps) * 100)) : 0;
        progressFill.style.width = pct + '%';
      }
      if (progressLabel) {
        progressLabel.textContent = (msg.stepCount || 0) + ' / ' + maxSteps + ' steps';
      }
      if (progressArea) {
        progressArea.classList.remove('hidden');
      }
      if (currentActionEl) {
        currentActionEl.classList.remove('hidden');
      }
      if (msg.events && msg.events.length > 0) {
        var latest = msg.events[msg.events.length - 1];
        if (currentActionIconEl) {
          currentActionIconEl.textContent = eventIcons[latest.type] || '•';
        }
        if (currentActionTextEl) {
          currentActionTextEl.textContent = latest.summary || info.label;
        }
      }

      // ── Plan tab: plan + reasoning ──
      if (msg.planText) {
        var planSection = document.getElementById('plan-section');
        if (planSection) planSection.style.display = '';
        var planContent = document.getElementById('plan-content');
        if (planContent) planContent.textContent = msg.planText;
        showTabDot('plan');
      } else {
        var planSection2 = document.getElementById('plan-section');
        if (planSection2) planSection2.style.display = 'none';
      }

      if (reasoningSectionEl && reasoningContentEl) {
        var reasoningText = typeof msg.reasoningText === 'string' ? msg.reasoningText : '';
        reasoningSectionEl.style.display = reasoningText ? '' : 'none';
        reasoningContentEl.textContent = reasoningText;
        if (reasoningText) showTabDot('plan');
      }

      // ── Output tab: response ──
      if (responseSectionEl && responseContentEl) {
        var responseText = typeof msg.responseText === 'string' ? msg.responseText : '';
        responseSectionEl.style.display = responseText ? '' : 'none';
        responseContentEl.textContent = responseText;
        if (responseText) showTabDot('output');
      }

      // ── Live tab: activity feed ──
      if (feedEl && msg.events && msg.events.length > knownEventCount) {
        var newEvents = msg.events.slice(knownEventCount);
        feedEl.insertAdjacentHTML('beforeend', newEvents.map(renderEventRow).join(''));
        knownEventCount = msg.events.length;
        if (autoScroll) { feedEl.scrollTop = feedEl.scrollHeight; }
        if (activeTab !== 'live') showTabDot('live');
      }

      // ── Live tab: input area ──
      if (inputArea) {
        inputArea.classList.toggle('visible', msg.state === 'awaiting_input');
      }

      // ── Live tab: permission area ──
      var permissionDescriptions = Array.isArray(msg.permissionDescriptions)
        ? msg.permissionDescriptions.filter(function(d) { return typeof d === 'string' && d.trim().length > 0; })
        : [];
      var permissions = Array.isArray(msg.permissions) ? msg.permissions : [];
      var permissionText = permissionDescriptions[0] || latestPermissionSummary(msg.events);
      var currentPerm = permissions[0];

      // Update kind badge
      if (currentPerm && permKindBadge) {
        var meta = getPermMeta(currentPerm.kind);
        permKindBadge.className = 'perm-kind-badge perm-kind--' + meta.variant;
        if (permKindIcon) permKindIcon.textContent = meta.icon;
        if (permKindLabel) permKindLabel.textContent = meta.label;
      }

      // Update detail block
      if (permDetailBlock && permDetailText) {
        if (currentPerm && currentPerm.detail) {
          permDetailText.textContent = currentPerm.detail;
          permDetailBlock.style.display = '';
        } else {
          permDetailBlock.style.display = 'none';
        }
      }

      if (permissionDescEl) {
        permissionDescEl.textContent = permissionText;
      }
      if (permissionQueueEl) {
        var queueLabel = formatQueuedPermissionLabel(permissionDescriptions);
        permissionQueueEl.textContent = queueLabel;
        permissionQueueEl.style.display = queueLabel ? '' : 'none';
      }
      if (permArea) {
        var awaitingApproval = msg.state === 'awaiting_approval';
        permArea.classList.toggle('visible', awaitingApproval);
        var nextPermissionSignature = permissionDescriptions.join('\\n');
        if (awaitingApproval && nextPermissionSignature && nextPermissionSignature !== permissionSignature) {
          permissionSignature = nextPermissionSignature;
          // Auto-switch to Live tab when permission required
          if (activeTab !== 'live') {
            document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
            var liveTab = document.querySelector('[data-tab="live"]');
            if (liveTab) liveTab.classList.add('active');
            var livePanel = document.getElementById('tab-live');
            if (livePanel) livePanel.classList.add('active');
            activeTab = 'live';
          }
          permArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (!awaitingApproval) {
          permissionSignature = '';
        }
      }
    });

    // ── Button handlers ───────────────────────────────────────────
    if (abortBtn) {
      abortBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'abort' });
      });
    }

    if (resumeBtn) {
      resumeBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'resumeSession' });
      });
    }

    if (startNewBtn) {
      startNewBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'startNewSession' });
      });
    }

    if (emptyStartNewBtn) {
      emptyStartNewBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'startNewSession' });
      });
    }

    if (sendBtn && textarea) {
      sendBtn.addEventListener('click', function() {
        var response = textarea.value.trim();
        if (response) {
          vscode.postMessage({ type: 'respondInput', response: response });
          textarea.value = '';
        }
      });
    }

    var approveOnce = document.getElementById('approve-once');
    if (approveOnce) {
      approveOnce.addEventListener('click', function() {
        vscode.postMessage({ type: 'respondPermission', decision: 'allow_once' });
      });
    }
    var approveAlways = document.getElementById('approve-always');
    if (approveAlways) {
      approveAlways.addEventListener('click', function() {
        vscode.postMessage({ type: 'respondPermission', decision: 'allow_always' });
      });
    }
    var denyPerm = document.getElementById('deny-perm');
    if (denyPerm) {
      denyPerm.addEventListener('click', function() {
        vscode.postMessage({ type: 'respondPermission', decision: 'deny' });
      });
    }

    if (feedEl) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }

    // Pause auto-scroll when user scrolls up manually
    if (feedEl && autoScrollToggle) {
      feedEl.addEventListener('scroll', function() {
        var atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
        if (!atBottom && autoScroll) {
          autoScroll = false;
          autoScrollToggle.checked = false;
        } else if (atBottom && !autoScroll) {
          autoScroll = true;
          autoScrollToggle.checked = true;
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private renderEvents(events: AgentEventSummary[], verbose: boolean): string {
    return events
      .map(event => {
        const icon = EVENT_ICONS[event.type] ?? '•';
        const time = this.formatTime(event.timestamp);
        const category = eventCategory(event.type);
        const hidden = category !== 'message' ? ' filtered-out' : '';
        const detail = event.detail
          ? `<div class="event-detail">${escapeHtml(event.detail)}</div>`
          : '';
        return `<div class="event-row${hidden}" data-category="${category}">
          <span class="event-icon">${icon}</span>
          <span class="event-time">${escapeHtml(time)}</span>
          <span class="event-summary">${escapeHtml(event.summary)}${detail}</span>
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

  private resolveBadgeVariant(state: string | undefined): string {
    switch (state) {
      case 'executing':
      case 'planning':
      case 'active':
        return 'active';
      case 'awaiting_approval':
      case 'awaiting_input':
      case 'paused':
        return 'warning';
      case 'failed':
      case 'aborted':
        return 'error';
      case 'completed':
        return 'info';
      default:
        return 'neutral';
    }
  }
}
