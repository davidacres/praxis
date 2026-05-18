import * as vscode from 'vscode';
import type { AiSessionManager } from '../ai/aiSessionManager';
import type { AgentSessionRecord } from '../ai/agentTypes';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { ConnectionStore } from '../config/connectionStore';
import { BoardStore } from '../state/boardStore';
import type { AiAssignment, AiProvider, BackendMode, Board, BoardDetails } from '../types';
import { parseHexRgb } from '../ui/hexColor';
import { boardListModeIconSvg, resolveBackendModeBoardIconColor } from './boardModeIcon';
import { BoardsTreeProvider } from './boardsTreeProvider';

interface WorkModeBoardsSidebarCallbacks {
  onSelectBoard: (boardId: string) => Promise<void>;
  onEditBoard: (boardId: string) => Promise<void>;
  onDeleteBoard: (boardId: string) => Promise<void>;
  onRemoveAllBoards: () => Promise<void>;
  onResetGitLabConfig: () => Promise<void>;
  onOpenSession: (issueKey: string, boardId?: string) => Promise<void>;
}

interface WorkModeBoardState {
  board: Board;
  details?: BoardDetails;
  loading: boolean;
  errorMessage?: string;
}

interface WorkModeSessionItem {
  boardId: string;
  issueKey: string;
  summary: string;
  providerLabel: string;
  statusLabel: string;
  statusToken: string;
  actionLabel: string;
  isActive: boolean;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  claude: 'Claude',
  'cursor-cli': 'Cursor CLI',
  'copilot-cli': 'GitHub Copilot SDK',
  'claude-cli': 'Claude Code CLI'
};

function boardRemovalLabel(mode: BackendMode): string {
  return mode === 'demo' || mode === 'userworkspace' ? 'Delete board' : 'Close board';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface BoardRenderIcons {
  modeIcon: string;
  modeIconColor: string;
  statusIcon: string;
  activityIcon: string;
  menuDotsIcon: string;
  openBoardIcon: string;
  editBoardIcon: string;
  deleteBoardIcon: string;
}

function getBoardStatus(activeCount: number, hasSessions: boolean, issueCount: number): string {
  if (activeCount > 0) { return 'In Progress'; }
  if (hasSessions) { return 'Complete'; }
  if (issueCount > 0) { return 'Queued'; }
  return 'Idle';
}

function getBoardPriority(activeCount: number, hasSessions: boolean): string {
  if (activeCount > 0) { return 'High'; }
  if (hasSessions) { return 'Medium'; }
  return 'Low';
}

function getBoardDescription(sessions: WorkModeSessionItem[], issueCount: number): string {
  const leadingSession = sessions[0];
  if (!leadingSession) {
    if (issueCount > 0) { return `${pluralize(issueCount, 'board item')} tracked on this board.`; }
    return 'No board items are currently available for this board.';
  }
  const extra = sessions.length > 1 ? ` + ${sessions.length - 1} more active context` : '';
  return `${leadingSession.summary}${extra}`;
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderPill(label: string, token: string): string {
  return `<span class="pill pill--${token}">${escapeHtml(label)}</span>`;
}

function isTerminalAgentState(state: string | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'aborted';
}

function resolveProviderLabel(
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
  return 'AI Session';
}

function resolveSessionState(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): { label: string; token: string; isActive: boolean } {
  if (record) {
    switch (record.state) {
      case 'planning':
        return { label: 'Planning', token: 'progress', isActive: true };
      case 'awaiting_approval':
        return { label: 'Awaiting Approval', token: 'blocked', isActive: true };
      case 'executing':
        return { label: 'Active', token: 'progress', isActive: true };
      case 'awaiting_input':
        return { label: 'Awaiting Input', token: 'blocked', isActive: true };
      case 'paused':
        return { label: 'Idle', token: 'status', isActive: false };
      case 'completed':
        return { label: 'Completed', token: 'done', isActive: false };
      case 'failed':
        return { label: 'Failed', token: 'blocked', isActive: false };
      case 'aborted':
        return { label: 'Cancelled', token: 'status', isActive: false };
      default:
        return { label: 'Assigned', token: 'status', isActive: false };
    }
  }

  switch (assignment?.status) {
    case 'active':
      return { label: 'Active', token: 'progress', isActive: true };
    case 'completed':
      return { label: 'Completed', token: 'done', isActive: false };
    case 'failed':
      return { label: 'Failed', token: 'blocked', isActive: false };
    default:
      return { label: 'Assigned', token: 'status', isActive: false };
  }
}

function findLatestEventSummary(record: AgentSessionRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }

  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event.summary?.trim()) {
      return event.summary.trim();
    }
  }

  return undefined;
}

function buildSessionActionLabel(
  assignment: AiAssignment | undefined,
  record: AgentSessionRecord | undefined
): string {
  const eventSummary = findLatestEventSummary(record);
  if (eventSummary) {
    return eventSummary;
  }
  if (record?.state === 'paused') {
    return 'Awaiting resume';
  }
  if (record?.state === 'awaiting_approval') {
    return 'Needs approval to continue';
  }
  if (record?.state === 'awaiting_input') {
    return 'Waiting for input';
  }
  if (record && !isTerminalAgentState(record.state) && record.state !== 'not_started') {
    return 'Session in progress';
  }
  if (assignment?.status === 'completed') {
    return 'Last run completed';
  }
  if (assignment?.status === 'failed') {
    return 'Last run failed';
  }
  return 'Session ready';
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildInitials(value: string): string {
  const initials = value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('');
  return initials || 'TM';
}

function resolveBoardMetaLabel(board: Board): string {
  return board.id.startsWith('jql:') ? board.name : board.id;
}

function resolveIconShellStyle(color: string): string {
  const rgb = parseHexRgb(color);
  if (!rgb) {
    return `color: ${color}; border-color: ${color};`;
  }

  const { r, g, b } = rgb;
  return `color: ${color}; border-color: rgba(${r}, ${g}, ${b}, 0.34); background: rgba(${r}, ${g}, ${b}, 0.08); box-shadow: inset 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.08), 0 0 18px rgba(${r}, ${g}, ${b}, 0.18);`;
}

function resolvePriorityTokenStyle(priority: string, priorityColors: Record<string, string>): string {
  const color = priorityColors[priority];
  const rgb = parseHexRgb(color);
  if (!rgb) {
    return '';
  }

  const { r, g, b } = rgb;
  return `color: ${color}; background: rgba(${r}, ${g}, ${b}, 0.12); border-color: rgba(${r}, ${g}, ${b}, 0.28);`;
}

export class WorkModeBoardsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedBoardId?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly boardStates = new Map<string, WorkModeBoardState>();
  private readonly expandedBoardIds = new Set<string>();
  private generation = 0;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly boardStore: BoardStore,
    private readonly boardsProvider: BoardsTreeProvider,
    private readonly aiSessionManager: AiSessionManager,
    private readonly getBackendMode: () => BackendMode,
    private readonly callbacks: WorkModeBoardsSidebarCallbacks,
    private readonly connectionStore?: ConnectionStore,
    private readonly resolveBoardService?: (board: Board) => Promise<IssueTrackerService>
  ) {
    this.disposables.push(
      this.boardsProvider.onDidChangeTreeData(() => {
        this.invalidateCache();
        this.render();
      }),
      this.boardStore.onDidChange(() => {
        this.invalidateCache();
        this.render();
      }),
      this.aiSessionManager.onDidChangeSession(() => {
        this.render();
      }),
      this.aiSessionManager.onDidChangeAgentSession(() => {
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ticketManager')) {
          this.render();
        }
      })
    );
  }

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

  public setSelectedBoardId(boardId: string | undefined): void {
    this.selectedBoardId = boardId;
    this.render();
  }

  public dispose(): void {
    this.view = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const payload = message as Record<string, unknown>;
    switch (payload.type) {
      case 'selectBoard':
        if (typeof payload.boardId === 'string') {
          await this.callbacks.onSelectBoard(payload.boardId);
        }
        return;
      case 'editBoard':
        if (typeof payload.boardId === 'string') {
          await this.callbacks.onEditBoard(payload.boardId);
        }
        return;
      case 'deleteBoard':
        if (typeof payload.boardId === 'string') {
          await this.callbacks.onDeleteBoard(payload.boardId);
        }
        return;
      case 'removeAllBoards':
        await this.callbacks.onRemoveAllBoards();
        return;
      case 'resetGitLabConfig':
        await this.callbacks.onResetGitLabConfig();
        return;
      case 'toggleBoardSessions':
        if (typeof payload.boardId === 'string') {
          this.handleToggleBoardSessions(payload.boardId);
        }
        return;
      case 'openSession':
        if (typeof payload.issueKey === 'string') {
          await this.callbacks.onOpenSession(
            payload.issueKey,
            typeof payload.boardId === 'string' ? payload.boardId : undefined
          );
        }
        return;
      default:
        return;
    }
  }

  private handleToggleBoardSessions(boardId: string): void {
    if (this.expandedBoardIds.has(boardId)) {
      this.expandedBoardIds.delete(boardId);
    } else {
      this.expandedBoardIds.add(boardId);
      this.refreshBoardDetail(boardId);
    }
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const snapshot = this.boardsProvider.getSnapshot();
    const filters = this.boardStore.getFilters();
    const nonce = createNonce();

    let content = '';
    if (snapshot.status === 'error') {
      content = `<div class="message error">${escapeHtml(snapshot.errorMessage ?? 'Unable to load boards.')}</div>`;
    } else if ((snapshot.status === 'idle' || snapshot.status === 'loading') && snapshot.boards.length === 0) {
      content = '<div class="message">Loading boards...</div>';
    } else if (snapshot.boards.length === 0) {
      const trimmedSearch = filters.searchText.trim();
      if (trimmedSearch.length > 0) {
        content = `<div class="message">No boards match "${escapeHtml(trimmedSearch)}".</div>`;
      } else if (filters.projectKeys.length > 0 || filters.types.length > 0) {
        content = '<div class="message">No boards match the current board filters.</div>';
      } else {
        content = '<div class="message">No boards are available.</div>';
      }
    } else {
      this.ensureBoardDetails(snapshot.boards);
      content = this.renderBoards(snapshot.boards);
    }

    this.view.title = undefined;
    this.view.description = String(snapshot.boards.length);
    this.view.badge = undefined;
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
        padding: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-sideBar-background);
      }
      .page { box-sizing: border-box; min-height: 100%; padding: 8px 10px 12px; }
      .message { padding: 10px 12px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
      .message.error { color: var(--vscode-errorForeground); }
      .work-board-list { display: flex; flex-direction: column; gap: 10px; padding: 0; }
      .work-board { position: relative; display: flex; flex-direction: column; gap: 0; }
      .work-board-card { position: relative; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 18px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 4px 16px rgba(0,0,0,0.28); overflow: visible; cursor: pointer; z-index: 2; }
      .work-board-card:hover { border-color: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.35)) 50%, var(--vscode-focusBorder, #6366f1) 50%); }
      .work-board-card.selected { border-color: var(--vscode-focusBorder, rgba(99,102,241,0.7)); box-shadow: 0 4px 16px rgba(0,0,0,0.32), 0 0 0 1px var(--vscode-focusBorder, rgba(99,102,241,0.3)); }
      .work-board-shell { padding: 13px 14px 12px; }
      .work-board-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .work-board-head-left { display: flex; align-items: flex-start; gap: 11px; min-width: 0; flex: 1; }
      .work-board-icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 9px; color: var(--vscode-textLink-foreground, var(--vscode-icon-foreground, var(--vscode-editor-foreground))); background: transparent; flex-shrink: 0; }
      .work-board-icon svg { width: 14px; height: 14px; display: block; }
      .work-board-title-wrap { min-width: 0; flex: 1; }
      .work-board-eyebrow { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 800; line-height: 1; letter-spacing: 0.03em; }
      .work-board-id { color: var(--vscode-descriptionForeground); opacity: 0.8; }
      .work-board-priority { display: inline-flex; align-items: center; padding: 1px 6px; border: 1px solid transparent; border-radius: 999px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
      .work-board-dot { width: 4px; height: 4px; border-radius: 999px; background: var(--vscode-panel-border, rgba(128,128,128,0.5)); flex-shrink: 0; }
      .work-board-title { margin: 0 0 4px; color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground)); font-size: 17px; font-weight: 780; line-height: 1.18; letter-spacing: -0.02em; }
      .work-board-summary { margin: 0; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.34; max-width: 100%; }
      .work-board-menu { position: relative; flex-shrink: 0; }
      .work-board-menu-trigger { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
      .work-board-menu-trigger:hover, .work-board-menu-trigger[aria-expanded="true"] { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground)); }
      .work-board-menu-trigger svg { width: 14px; height: 14px; display: block; }
      .work-board-menu-panel { position: absolute; top: calc(100% + 8px); right: 0; min-width: 148px; padding: 6px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 14px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background))); box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 4; }
      .work-board-menu-panel[hidden] { display: none; }
      .work-board-menu-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground)); font-size: 12px; font-weight: 700; text-align: left; cursor: pointer; }
      .work-board-menu-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
      .work-board-menu-item.danger { color: var(--vscode-errorForeground, #f87171); }
      .work-board-menu-item svg { width: 14px; height: 14px; display: block; flex-shrink: 0; color: inherit; }
      .work-board-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 11px; }
      .work-board-meta { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; color: color-mix(in srgb, var(--vscode-descriptionForeground) 88%, transparent); }
      .work-board-status { display: inline-flex; align-items: center; gap: 5px; color: inherit; font-size: 10px; font-weight: 600; opacity: 0.92; }
      .work-board-status svg { width: 12px; height: 12px; display: block; color: color-mix(in srgb, var(--vscode-descriptionForeground) 72%, transparent); }
      .work-board-owner { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: inherit; font-size: 10px; font-weight: 600; opacity: 0.88; }
      .work-board-owner-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .work-board-assignee-badge { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-badge-background, var(--vscode-panel-border)) 20%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.35)) 75%, transparent); color: var(--vscode-descriptionForeground); font-size: 7px; font-weight: 800; flex-shrink: 0; }
      .work-board-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 8px 11px; border: 1px solid transparent; border-radius: 10px; background: var(--vscode-button-background, #5b56f0); color: var(--vscode-button-foreground, #ffffff); font-size: 11px; font-weight: 800; line-height: 1; cursor: pointer; }
      .work-board-toggle:hover { background: var(--vscode-button-hoverBackground, #4f46e5); }
      .work-board-toggle.expanded { background: rgba(99,102,241,0.12); color: var(--vscode-textLink-foreground, #818cf8); border-color: rgba(99,102,241,0.3); box-shadow: none; }
      .work-board-toggle svg { width: 12px; height: 12px; display: block; transition: transform 160ms ease; }
      .work-board-toggle.expanded svg { transform: rotate(180deg); }
      .work-board-stack-wrapper { display: grid; grid-template-rows: 0fr; width: calc(100% - 14px); margin: -6px auto 0; z-index: 1; transition: grid-template-rows 280ms cubic-bezier(0.16, 1, 0.3, 1); }
      .work-board-stack-wrapper.stack-visible { grid-template-rows: 1fr; }
      .work-board-stack-wrapper.closing { pointer-events: none; }
      .work-board-stack-wrapper.no-anim { transition: none !important; }
      .work-board-stack { position: relative; min-height: 0; overflow: hidden; padding: 14px 0 9px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 84%, transparent); border-top: 0; border-radius: 0 0 16px 16px; background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 89%, var(--vscode-sideBar-background) 11%); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 45%, transparent), 0 4px 12px rgba(0,0,0,0.14); }
      .work-board-stack::before { content: ''; position: absolute; top: 0; left: 14px; right: 14px; height: 1px; background: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 45%, transparent); opacity: 0.55; }
      .work-board-activity { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 0 16px; }
      .work-board-activity svg { width: 11px; height: 11px; display: block; color: color-mix(in srgb, var(--vscode-descriptionForeground) 74%, transparent); }
      .work-board-activity-label { color: var(--vscode-descriptionForeground); font-size: 8px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.58; }
      .work-board-activity-line { height: 1px; flex: 1; background: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 72%, transparent); }
      .work-session-list-container { margin: 0 11px; }
      .work-session-list { display: flex; flex-direction: column; gap: 8px; padding: 0; }
      .work-session-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.3)) 82%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 94%, transparent); box-shadow: 0 1px 4px rgba(0,0,0,0.14); cursor: pointer; text-align: left; }
      .work-session-row:hover { border-color: color-mix(in srgb, var(--vscode-focusBorder, rgba(99,102,241,0.5)) 58%, var(--vscode-panel-border, rgba(128,128,128,0.3)) 42%); background: color-mix(in srgb, var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)) 60%, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 40%); }
      .work-session-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
      .work-session-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14)); color: var(--vscode-descriptionForeground); flex-shrink: 0; }
      .work-session-icon svg { width: 12px; height: 12px; display: block; }
      .work-session-indicator { position: absolute; top: -1px; right: -1px; width: 9px; height: 9px; border-radius: 999px; border: 2px solid var(--vscode-editorWidget-background, var(--vscode-editor-background)); background: var(--vscode-panel-border, rgba(128,128,128,0.5)); }
      .work-session-indicator.active { background: #10b981; }
      .work-session-copy { min-width: 0; flex: 1; }
      .work-session-headline { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .work-session-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground)); font-size: 11px; font-weight: 800; }
      .work-session-subtitle { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 9px; line-height: 1.2; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .work-session-chevron { width: 12px; height: 12px; color: color-mix(in srgb, var(--vscode-descriptionForeground) 52%, transparent); flex-shrink: 0; }
      .work-board-list-header { display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 0 10px 8px; }
      .work-board-remove-all { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 10px; background: transparent; color: var(--vscode-errorForeground, #f87171); font-size: 11px; font-weight: 700; cursor: pointer; opacity: 0.75; }
      .work-board-remove-all:hover { opacity: 1; background: color-mix(in srgb, var(--vscode-errorForeground, #f87171) 10%, transparent); border-color: var(--vscode-errorForeground, #f87171); }
      .work-board-remove-all svg { width: 12px; height: 12px; display: block; flex-shrink: 0; }
      .work-board-reset-config { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 10px; background: transparent; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; cursor: pointer; opacity: 0.75; }
      .work-board-reset-config:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
      .work-board-reset-config svg { width: 12px; height: 12px; display: block; flex-shrink: 0; }
      .pill { display: inline-flex; align-items: center; flex-shrink: 0; padding: 1px 5px; border: 1px solid transparent; border-radius: 999px; font-size: 9px; font-weight: 600; line-height: 1.35; }
      .pill--progress { color: #6ee7b7; background: rgba(16,185,129,0.15); border-color: rgba(16,185,129,0.3); }
      .pill--done { color: #93c5fd; background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.3); }
      .pill--blocked { color: #fca5a5; background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.3); }
      .pill--status { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-badge-background, transparent) 65%, transparent); border-color: transparent; }
      .work-board-empty, .work-board-loading, .work-board-error { margin-top: 12px; padding: 10px 12px; border-radius: 12px; font-size: 11px; line-height: 1.4; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
      .work-board-loading, .work-board-empty { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)) 92%, transparent); }
      .work-board-error { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, transparent) 55%, transparent); }

    </style>
  </head>
  <body>
    <div class="page">
      ${content}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      // Animate newly expanded stacks; skip transition for stacks already visible before this render.
      try {
        const prevExpanded = new Set(JSON.parse(sessionStorage.getItem('expandedStacks') || '[]'));
        const nowExpanded = new Set();
        for (const stack of document.querySelectorAll('[data-board-stack-id]')) {
          const id = stack.getAttribute('data-board-stack-id');
          if (id) { nowExpanded.add(id); }
          if (prevExpanded.has(id)) {
            stack.classList.add('no-anim', 'stack-visible');
          } else {
            requestAnimationFrame(() => requestAnimationFrame(() => stack.classList.add('stack-visible')));
          }
        }
        sessionStorage.setItem('expandedStacks', JSON.stringify([...nowExpanded]));
      } catch (_) {}
      for (const row of document.querySelectorAll('[data-board-id]')) {
        row.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'selectBoard', boardId: row.getAttribute('data-board-id') });
        });
      }
      function postToggleBoardSessions(boardId) {
        vscodeApi.postMessage({ type: 'toggleBoardSessions', boardId });
      }
      for (const button of document.querySelectorAll('[data-toggle-board-id]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const boardId = button.getAttribute('data-toggle-board-id');
          if (!boardId) {
            return;
          }
          const isExpanded = button.classList.contains('expanded');
          if (!isExpanded) {
            postToggleBoardSessions(boardId);
            return;
          }

          const stack = document.querySelector('[data-board-stack-id="' + boardId + '"]');
          if (!(stack instanceof HTMLElement)) {
            postToggleBoardSessions(boardId);
            return;
          }

          stack.classList.remove('no-anim');
          stack.classList.add('closing');
          void stack.offsetHeight;
          stack.classList.remove('stack-visible');
          window.setTimeout(() => postToggleBoardSessions(boardId), 220);
        });
      }
      for (const button of document.querySelectorAll('[data-open-session-issue-key]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({
            type: 'openSession',
            issueKey: button.getAttribute('data-open-session-issue-key'),
            boardId: button.getAttribute('data-open-session-board-id')
          });
        });
      }
      const menuPanels = new Map();
      function closeMenus() {
        for (const [boardId, panel] of menuPanels.entries()) {
          panel.hidden = true;
          const trigger = document.querySelector('[data-menu-trigger-board-id="' + boardId + '"]');
          if (trigger) {
            trigger.setAttribute('aria-expanded', 'false');
          }
        }
      }
      for (const panel of document.querySelectorAll('[data-menu-panel-board-id]')) {
        menuPanels.set(panel.getAttribute('data-menu-panel-board-id'), panel);
        panel.addEventListener('click', event => event.stopPropagation());
      }
      for (const button of document.querySelectorAll('[data-menu-trigger-board-id]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const boardId = button.getAttribute('data-menu-trigger-board-id');
          const panel = boardId ? menuPanels.get(boardId) : undefined;
          if (!panel) {
            return;
          }
          const nextExpanded = panel.hidden;
          closeMenus();
          panel.hidden = !nextExpanded;
          button.setAttribute('aria-expanded', String(nextExpanded));
        });
      }
      for (const button of document.querySelectorAll('[data-menu-action]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const boardId = button.getAttribute('data-menu-board-id');
          const action = button.getAttribute('data-menu-action');
          closeMenus();
          if (!boardId || !action) {
            return;
          }
          vscodeApi.postMessage({ type: action, boardId });
        });
      }
      document.addEventListener('click', closeMenus);
      const removeAllBtn = document.getElementById('removeAllBoards');
      if (removeAllBtn) {
        removeAllBtn.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'removeAllBoards' });
        });
      }
      const resetConfigBtn = document.getElementById('resetGitLabConfig');
      if (resetConfigBtn) {
        resetConfigBtn.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'resetGitLabConfig' });
        });
      }
    </script>
  </body>
</html>`;
  }

  private ensureBoardDetails(boards: Board[]): void {
    const activeIds = new Set(boards.map(board => board.id));
    for (const cachedId of this.boardStates.keys()) {
      if (!activeIds.has(cachedId)) {
        this.boardStates.delete(cachedId);
        this.expandedBoardIds.delete(cachedId);
      }
    }

    const missingBoards = boards.filter(board => !this.boardStates.has(board.id));
    if (missingBoards.length === 0) {
      for (const board of boards) {
        const state = this.boardStates.get(board.id);
        if (state) {
          state.board = board;
        }
      }
      return;
    }

    const generation = ++this.generation;
    for (const board of missingBoards) {
      this.boardStates.set(board.id, { board, loading: true });
    }

    void Promise.all(
      missingBoards.map(async board => {
        try {
          const details = await this.getBoardService(board).then(service => service.getBoardDetails(board));
          return { boardId: board.id, state: { board, details, loading: false } satisfies WorkModeBoardState };
        } catch (error) {
          return {
            boardId: board.id,
            state: {
              board,
              loading: false,
              errorMessage: error instanceof Error ? error.message : String(error)
            } satisfies WorkModeBoardState
          };
        }
      })
    ).then(results => {
      if (generation !== this.generation) {
        return;
      }
      for (const result of results) {
        this.boardStates.set(result.boardId, result.state);
      }
      this.render();
    });
  }

  private invalidateCache(): void {
    this.generation += 1;
    this.boardStates.clear();
    this.expandedBoardIds.clear();
  }

  private refreshBoardDetail(boardId: string): void {
    const state = this.boardStates.get(boardId);
    if (!state || state.loading) {
      return;
    }

    const generation = ++this.generation;
    this.boardStates.set(boardId, { board: state.board, details: state.details, loading: true });
    void this.getBoardService(state.board)
      .then(service => service.getBoardDetails(state.board))
      .then(details => {
        if (generation !== this.generation) {
          return;
        }
        this.boardStates.set(boardId, { board: state.board, details, loading: false });
        this.render();
      })
      .catch(error => {
        if (generation !== this.generation) {
          return;
        }
        this.boardStates.set(boardId, {
          board: state.board,
          details: state.details,
          loading: false,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        this.render();
      });
  }

  private async getBoardService(board: Board): Promise<IssueTrackerService> {
    if (board.connectionId && this.resolveBoardService) {
      return this.resolveBoardService(board);
    }

    return this.backendService;
  }

  private renderBoards(boards: Board[]): string {
    const fallbackMode = this.getBackendMode();
    const priorityColors = vscode.workspace.getConfiguration('ticketManager').get<Record<string, string>>('priorityColors', {});
    const resolveBoardMode = (connectionId: string | undefined): BackendMode => {
      if (connectionId && this.connectionStore) {
        const conn = this.connectionStore.getConnection(connectionId);
        if (conn) {
          return conn.mode;
        }
      }
      return fallbackMode;
    };
    const fallbackModeIconMarkup = boardListModeIconSvg(fallbackMode);
    const fallbackModeIconColor = resolveBackendModeBoardIconColor(fallbackMode);
    const statusIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M2 8h2.4l1.2-3.2L8 11.2 10 5.8l1.1 2.2H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const activityIcon = '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="4.5" width="11" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 4V3a2 2 0 1 1 4 0v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    const menuDotsIcon = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.25" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.75" cy="8" r="1.25"/></svg>';
    const openBoardIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M5.5 10.5L10.5 5.5M7 5.5h3.5V9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 8.5V11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const editBoardIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 11.8l2.5-.5 5.7-5.7a1.3 1.3 0 0 0-1.8-1.8L3.7 9.5 3 11.8z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const deleteBoardIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M5 6.5v5m3-5v5m3-5v5M4.5 4.5l.5 8.1c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.5-8.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const removeAllIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M5 6.5v5m3-5v5m3-5v5M4.5 4.5l.5 8.1c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.5-8.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const resetConfigIcon = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 0 .8-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 4.5V8h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const hasGitLabBoard = boards.some(b => resolveBoardMode(b.connectionId) === 'gitlab');
    const resetConfigBtn = hasGitLabBoard
      ? `<button class="work-board-reset-config" type="button" id="resetGitLabConfig">${resetConfigIcon}<span>Reset config</span></button>`
      : '';
    const icons: BoardRenderIcons = { modeIcon: fallbackModeIconMarkup, modeIconColor: fallbackModeIconColor, statusIcon, activityIcon, menuDotsIcon, openBoardIcon, editBoardIcon, deleteBoardIcon };
    return `<div>
      <div class="work-board-list-header">
        ${resetConfigBtn}
        <button class="work-board-remove-all" type="button" id="removeAllBoards">${removeAllIcon}<span>Remove all</span></button>
      </div>
      <div class="work-board-list">
        ${boards
          .map(board => {
            const boardMode = resolveBoardMode(board.connectionId);
            const perBoardIcons: BoardRenderIcons = {
              ...icons,
              modeIcon: boardListModeIconSvg(boardMode),
              modeIconColor: resolveBackendModeBoardIconColor(boardMode)
            };
            return this.renderBoard(board, perBoardIcons, boardRemovalLabel(boardMode), priorityColors);
          })
          .join('')}
      </div>
    </div>`;
  }

  private renderBoard(
    board: Board,
    icons: BoardRenderIcons,
    removalLabel: string,
    priorityColors: Record<string, string>
  ): string {
    const state = this.boardStates.get(board.id) ?? { board, loading: true };
    const issueCount = state.details?.issues.length ?? 0;
    const sessions = this.getSessions(board.id, state.details);
    const hasSessions = sessions.length > 0;
    const isExpanded = this.expandedBoardIds.has(board.id);
    const activeCount = sessions.filter(session => session.isActive).length;
    const boardStatus = getBoardStatus(activeCount, hasSessions, issueCount);
    const projectOrLocation = this.resolveProjectOrLocation(board);
    const boardMetaLabel = resolveBoardMetaLabel(board);
    const description = getBoardDescription(sessions, issueCount);
    const initials = buildInitials(projectOrLocation);
    const boardPriority = getBoardPriority(activeCount, hasSessions);
    const boardPriorityStyle = resolvePriorityTokenStyle(boardPriority, priorityColors);
    const selectedClass = this.selectedBoardId === board.id ? 'selected' : '';
    const loadingMarkup = state.loading && !isExpanded ? '<div class="work-board-loading">Loading board activity...</div>' : '';
    const errorMarkup = state.errorMessage ? `<div class="work-board-error">${escapeHtml(state.errorMessage)}</div>` : '';
    const emptyMarkup = !state.loading && !state.errorMessage && state.details?.issues.length === 0
      ? '<div class="work-board-empty">No issues are currently assigned to this board.</div>'
      : '';
    const expandedClass = isExpanded ? 'expanded' : '';
    const footerAction = hasSessions
      ? `<button class="work-board-toggle ${expandedClass}" data-toggle-board-id="${escapeHtml(board.id)}" type="button"><span>Sessions</span><svg viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      : `<span class="work-board-status">${escapeHtml(pluralize(issueCount, 'item'))}</span>`;
    const stackMarkup = isExpanded && hasSessions ? this.renderExpandedSessions(board.id, sessions, icons.activityIcon, state.loading) : '';

    return `<section class="work-board">
      <div class="work-board-card ${selectedClass}" data-board-id="${escapeHtml(board.id)}" title="${escapeHtml(board.name)}">
        <div class="work-board-shell">
          <div class="work-board-head">
            <div class="work-board-head-left">
              <span class="work-board-icon" style="${escapeHtml(resolveIconShellStyle(icons.modeIconColor))}">${icons.modeIcon}</span>
              <div class="work-board-title-wrap">
                <div class="work-board-eyebrow">
                  <span class="work-board-id">${escapeHtml(boardMetaLabel)}</span>
                  <span class="work-board-dot"></span>
                  <span class="work-board-priority" style="${escapeHtml(boardPriorityStyle)}">${escapeHtml(boardPriority)}</span>
                </div>
                <h2 class="work-board-title">${escapeHtml(board.name)}</h2>
                <p class="work-board-summary">${escapeHtml(description)}</p>
              </div>
            </div>
            <div class="work-board-menu">
              <button class="work-board-menu-trigger" type="button" aria-expanded="false" data-menu-trigger-board-id="${escapeHtml(board.id)}" title="More actions">
                ${icons.menuDotsIcon}
              </button>
              <div class="work-board-menu-panel" data-menu-panel-board-id="${escapeHtml(board.id)}" hidden>
                <button class="work-board-menu-item" type="button" data-menu-action="selectBoard" data-menu-board-id="${escapeHtml(board.id)}">${icons.openBoardIcon}<span>Open board</span></button>
                <button class="work-board-menu-item" type="button" data-menu-action="editBoard" data-menu-board-id="${escapeHtml(board.id)}">${icons.editBoardIcon}<span>Edit board</span></button>
                <button class="work-board-menu-item danger" type="button" data-menu-action="deleteBoard" data-menu-board-id="${escapeHtml(board.id)}">${icons.deleteBoardIcon}<span>${escapeHtml(removalLabel)}</span></button>
              </div>
            </div>
          </div>
          <div class="work-board-footer">
            <div class="work-board-meta">
              <span class="work-board-status">${icons.statusIcon}<span>${escapeHtml(boardStatus)}</span></span>
              <span class="work-board-owner"><span class="work-board-assignee-badge">${escapeHtml(initials)}</span><span class="work-board-owner-label">${escapeHtml(projectOrLocation)}</span></span>
            </div>
            ${footerAction}
          </div>
          ${loadingMarkup}
          ${errorMarkup}
          ${emptyMarkup}
        </div>
      </div>
      ${stackMarkup}
    </section>`;
  }

  private renderExpandedSessions(boardId: string, sessions: WorkModeSessionItem[], activityIcon: string, loading = false): string {
    const listContent = loading && sessions.length === 0
      ? '<div class="work-board-loading">Loading board activity...</div>'
      : `<div class="work-session-list-container">
        <div class="work-session-list">
          ${sessions.map(session => this.renderSession(session)).join('')}
        </div>
      </div>`;
    return `<div class="work-board-stack-wrapper" data-board-stack-id="${escapeHtml(boardId)}">
      <div class="work-board-stack">
        <div class="work-board-activity">
          ${activityIcon}
          <span class="work-board-activity-label">Agent Activity</span>
          <span class="work-board-activity-line"></span>
        </div>
        ${listContent}
      </div>
    </div>`;
  }

  private renderSession(session: WorkModeSessionItem): string {
    const sessionTitle = `${session.issueKey} ${session.summary}`;
    const subtitle = `${session.issueKey} • ${session.actionLabel}`;
    return `<button class="work-session-row" type="button" data-open-session-issue-key="${escapeHtml(session.issueKey)}" data-open-session-board-id="${escapeHtml(session.boardId)}" title="${escapeHtml(sessionTitle)}">
      <div class="work-session-left">
        <span class="work-session-icon">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M8 1.5l1.76 3.56 3.93.57-2.84 2.76.67 3.91L8 10.45 4.48 12.3l.67-3.91L2.31 5.63l3.93-.57L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span class="work-session-indicator ${session.isActive ? 'active' : ''}"></span>
        </span>
        <span class="work-session-copy">
          <span class="work-session-headline">
            <span class="work-session-title">${escapeHtml(session.providerLabel)}</span>
            ${renderPill(session.statusLabel, session.statusToken)}
          </span>
          <span class="work-session-subtitle">${escapeHtml(subtitle)}</span>
        </span>
      </div>
      <svg class="work-session-chevron" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  }

  private resolveProjectOrLocation(board: Board): string {
    if (board.projectKey && board.projectName) {
      return `${board.projectKey} \u2022 ${board.projectName}`;
    }
    return board.projectKey ?? board.locationName ?? 'Workspace';
  }

  private getSessions(boardId: string, details: BoardDetails | undefined): WorkModeSessionItem[] {
    if (!details) {
      return [];
    }

    return details.issues
      .map(issue => {
        const assignment = this.aiSessionManager.getSession(issue.key);
        const record = this.aiSessionManager.getAgentSession(issue.key);
        if (!assignment && !record) {
          return undefined;
        }
        const sessionBoardId = record?.boardId ?? assignment?.boardId;
        if (sessionBoardId && sessionBoardId !== boardId) {
          return undefined;
        }

        const state = resolveSessionState(assignment, record);
        return {
          boardId,
          issueKey: issue.key,
          summary: issue.summary,
          providerLabel: resolveProviderLabel(assignment, record),
          statusLabel: state.label,
          statusToken: state.token,
          actionLabel: buildSessionActionLabel(assignment, record),
          isActive: state.isActive
        } satisfies WorkModeSessionItem;
      })
      .filter((session): session is WorkModeSessionItem => Boolean(session))
      .sort((left, right) => {
        if (left.isActive !== right.isActive) {
          return left.isActive ? -1 : 1;
        }
        return left.issueKey.localeCompare(right.issueKey);
      });
  }
}