import * as vscode from 'vscode';
import type { IssueDetails } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { normalizeTaskDesignerPersistedState } from './taskDesignerStatePersistence';

const NOTE_TEST_STATE_KEY = 'ticketManager.noteTest.state';

type LinkHandleDirection = 'top' | 'right' | 'bottom' | 'left';

interface TicketNode {
  type: 'ticket';
  id: string;
  issueKey: string;
  summary: string;
  issueType: string;
  status: string;
  assignee?: string;
  priority?: string;
  projectKey: string;
  x: number;
  y: number;
}

interface NoteNode {
  type: 'note';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WebsitePreviewNode {
  type: 'website';
  id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type CanvasNode = TicketNode | NoteNode | WebsitePreviewNode;

interface DirectedConnector {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceDirection?: LinkHandleDirection;
  targetDirection?: LinkHandleDirection;
}

interface NoteTestState {
  nodes: CanvasNode[];
  connectors: DirectedConnector[];
  zoom: number;
  toolbarPosition: {
    x: number;
    y: number;
  };
}

interface NoteTestStateRecoveryResult {
  state: NoteTestState;
  repaired: boolean;
  warning?: string;
}

type ConnectorGraphValidationCode = 'duplicate-edge' | 'cycle';

interface ConnectorGraphValidationError {
  code: ConnectorGraphValidationCode;
  sourceNodeId: string;
  targetNodeId: string;
  message: string;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asLinkHandleDirection(value: unknown): LinkHandleDirection | undefined {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
    ? value
    : undefined;
}

function toTicketNode(value: unknown, fallbackIndex = 0): TicketNode | undefined {
  if (!isRecord(value) || value.type === 'note' || value.type === 'website') {
    return undefined;
  }

  const issueKey = asString(value.issueKey) ?? asString(value.key);
  if (!issueKey) {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 4;
  const fallbackRow = Math.floor(fallbackIndex / 4);

  return {
    type: 'ticket',
    id: asString(value.id) ?? `ticket-${issueKey}-${fallbackIndex}`,
    issueKey,
    summary: asString(value.summary) ?? issueKey,
    issueType: asString(value.issueType) ?? 'Unknown',
    status: asString(value.status) ?? 'Unknown',
    assignee: asString(value.assignee),
    priority: asString(value.priority),
    projectKey: asString(value.projectKey) ?? (/^([A-Za-z]\w+)-\d+$/.exec(issueKey)?.[1] ?? 'UNKNOWN'),
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 280)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 160))
  };
}

function toNoteNode(value: unknown, fallbackIndex = 0): NoteNode | undefined {
  if (!isRecord(value) || value.type !== 'note') {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 3;
  const fallbackRow = Math.floor(fallbackIndex / 3);

  return {
    type: 'note',
    id: asString(value.id) ?? `note-${fallbackIndex}`,
    title: asString(value.title) ?? 'Notes',
    content: asString(value.content) ?? '',
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 300)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 220)),
    width: Math.max(220, asNumber(value.width) ?? 280),
    height: Math.max(150, asNumber(value.height) ?? 190)
  };
}

function toWebsitePreviewNode(value: unknown, fallbackIndex = 0): WebsitePreviewNode | undefined {
  if (!isRecord(value) || value.type !== 'website') {
    return undefined;
  }

  const url = asString(value.url);
  if (!url) {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 3;
  const fallbackRow = Math.floor(fallbackIndex / 3);

  return {
    type: 'website',
    id: asString(value.id) ?? `website-${fallbackIndex}`,
    url,
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 320)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 240)),
    width: Math.max(240, asNumber(value.width) ?? 360),
    height: Math.max(180, asNumber(value.height) ?? 260)
  };
}

function toDirectedConnector(value: unknown): DirectedConnector | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceNodeId = asString(value.sourceNodeId);
  const targetNodeId = asString(value.targetNodeId);
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    return undefined;
  }

  return {
    id: asString(value.id) ?? `connector-${sourceNodeId}-${targetNodeId}`,
    sourceNodeId,
    targetNodeId,
    sourceDirection: asLinkHandleDirection(value.sourceDirection),
    targetDirection: asLinkHandleDirection(value.targetDirection)
  };
}

function normalizePersistedState(rawState: unknown): NoteTestState {
  return normalizePersistedStateWithRecovery(rawState).state;
}

function normalizePersistedStateWithRecovery(rawState: unknown): NoteTestStateRecoveryResult {
  const recovered = normalizeTaskDesignerPersistedState(rawState);
  return {
    state: {
      nodes: recovered.state.nodes as CanvasNode[],
      connectors: recovered.state.connectors as DirectedConnector[],
      zoom: recovered.state.zoom,
      toolbarPosition: {
        x: recovered.state.toolbarPosition.x,
        y: recovered.state.toolbarPosition.y
      }
    },
    repaired: recovered.repaired,
    warning: recovered.warning?.replace('Task Designer', 'Note Test')
  };
}

function detectDuplicateConnector(connectors: readonly DirectedConnector[]): DirectedConnector | undefined {
  const seen = new Set<string>();
  for (const connector of connectors) {
    const key = `${connector.sourceNodeId}\u0000${connector.targetNodeId}`;
    if (seen.has(key)) {
      return connector;
    }
    seen.add(key);
  }
  return undefined;
}

function detectCycleConnector(connectors: readonly DirectedConnector[]): DirectedConnector | undefined {
  const adjacency = new Map<string, string[]>();
  for (const connector of connectors) {
    const sourceList = adjacency.get(connector.sourceNodeId);
    if (sourceList) {
      sourceList.push(connector.targetNodeId);
    } else {
      adjacency.set(connector.sourceNodeId, [connector.targetNodeId]);
    }
    if (!adjacency.has(connector.targetNodeId)) {
      adjacency.set(connector.targetNodeId, []);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  let cycleConnector: DirectedConnector | undefined;

  const visit = (nodeId: string): boolean => {
    visited.add(nodeId);
    active.add(nodeId);
    const nextNodeIds = adjacency.get(nodeId) ?? [];
    for (const nextNodeId of nextNodeIds) {
      if (!visited.has(nextNodeId)) {
        if (visit(nextNodeId)) {
          if (!cycleConnector) {
            cycleConnector = {
              id: '',
              sourceNodeId: nodeId,
              targetNodeId: nextNodeId
            };
          }
          return true;
        }
        continue;
      }
      if (active.has(nextNodeId)) {
        cycleConnector = {
          id: '',
          sourceNodeId: nodeId,
          targetNodeId: nextNodeId
        };
        return true;
      }
    }
    active.delete(nodeId);
    return false;
  };

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) {
      continue;
    }
    if (visit(nodeId)) {
      return cycleConnector;
    }
  }

  return undefined;
}

function validateConnectorGraph(connectors: readonly DirectedConnector[]): ConnectorGraphValidationError | undefined {
  const duplicate = detectDuplicateConnector(connectors);
  if (duplicate) {
    return {
      code: 'duplicate-edge',
      sourceNodeId: duplicate.sourceNodeId,
      targetNodeId: duplicate.targetNodeId,
      message: 'Duplicate directed links are not allowed.'
    };
  }

  const cycleConnector = detectCycleConnector(connectors);
  if (cycleConnector) {
    return {
      code: 'cycle',
      sourceNodeId: cycleConnector.sourceNodeId,
      targetNodeId: cycleConnector.targetNodeId,
      message: 'Directed links cannot create cycles.'
    };
  }

  return undefined;
}

type NoteTestToolbarIcon =
  | 'select'
  | 'ticket'
  | 'note'
  | 'website'
  | 'link'
  | 'zoomIn'
  | 'zoomOut'
  | 'deleteConnector'
  | 'reset'
  | 'confirm'
  | 'dismiss';

function renderToolbarIcon(icon: NoteTestToolbarIcon): string {
  switch (icon) {
    case 'select':
      return '<path d="M4 3.5l8 3.6-3.6 1.3L7 12 4 3.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" />';
    case 'ticket':
      return '<path d="M5 3.5h5l2 2V12.5H5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none" /><path d="M10 3.5v2h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M8.5 7v3M7 8.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />';
    case 'note':
      return '<path d="M4 3.25h6l2 2v7.5H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" /><path d="M10 3.25v2h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /><path d="M6 7h4M6 9.25h4M6 11.5h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'website':
      return '<rect x="2.7" y="3" width="10.6" height="10" rx="1.8" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M2.7 5.8h10.6" stroke="currentColor" stroke-width="1.3" /><circle cx="4.6" cy="4.4" r="0.55" fill="currentColor" /><circle cx="6.5" cy="4.4" r="0.55" fill="currentColor" /><circle cx="8.4" cy="4.4" r="0.55" fill="currentColor" /><path d="M5.2 9.6c.9-1.4 2.2-2 3.9-1.9M5.7 11.1c1.1-1.1 2.2-1.5 3.7-1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />';
    case 'link':
      return '<path d="M6.2 9.8 4.9 11a2 2 0 1 1-2.9-2.8l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /><path d="M9.8 6.2 11.1 5a2 2 0 1 1 2.9 2.8l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /><path d="M6 10l4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />';
    case 'zoomIn':
      return '<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M11.5 11.5 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /><path d="M8 6.2v3.6M6.2 8h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'zoomOut':
      return '<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M11.5 11.5 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /><path d="M6.2 8h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'deleteConnector':
      return '<path d="M3.5 4.5h9M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M5 6.5v5m3-5v5m3-5v5M4.5 4.5l.5 8.1c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.5-8.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />';
    case 'confirm':
      return '<path d="M3.5 8.5 6.5 11.5 12.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />';
    case 'dismiss':
      return '<path d="M4.5 4.5 11.5 11.5M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />';
    case 'reset':
      return '<path d="M3.2 8A4.8 4.8 0 1 1 8 12.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M3.2 4.8v3.2H6.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  }
}

function renderToolbarButton(
  id: string,
  action: string | undefined,
  label: string,
  icon: NoteTestToolbarIcon,
  options?: {
    disabled?: boolean;
    extraClass?: string;
  }
): string {
  const className = ['overlay-icon-button', options?.extraClass].filter(Boolean).join(' ');
  const actionAttribute = action ? ` data-action="${action}"` : '';
  const disabledAttribute = options?.disabled ? ' disabled' : '';
  return `<button id="${id}" class="${className}" type="button" title="${label}" aria-label="${label}"${actionAttribute}${disabledAttribute}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${renderToolbarIcon(icon)}</svg>
  </button>`;
}

export class NoteTestPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private nextNodeIndex = 0;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly backendService: IssueTrackerService
  ) {}

  public open(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    const recoveredState = this.getPersistedCanvasState();
    const state = recoveredState.state;
    this.syncNextNodeIndex(state.nodes);

    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.noteTest',
      'Note Test',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = this.getHtml(nonce, state);

    this.panel = panel;
    if (recoveredState.repaired) {
      void this.workspaceState.update(NOTE_TEST_STATE_KEY, state);
    }

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    if (message.type === 'persist' || message.type === 'persistCanvasState') {
      const recoveredState = normalizePersistedStateWithRecovery(message.state ?? message);
      const graphError = validateConnectorGraph(recoveredState.state.connectors);
      if (graphError) {
        return;
      }
      await this.workspaceState.update(NOTE_TEST_STATE_KEY, recoveredState.state);
      this.syncNextNodeIndex(recoveredState.state.nodes);
      return;
    }

    if (message.type === 'addTicket') {
      await this.handleAddTicketMessage(message);
    }
  }

  private syncNextNodeIndex(nodes: readonly CanvasNode[]): void {
    let maxIndex = -1;
    for (const node of nodes) {
      const match = /-(\d+)$/.exec(node.id);
      const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        maxIndex = Math.max(maxIndex, parsed);
      }
    }
    if (maxIndex < 0 && nodes.length > 0) {
      maxIndex = nodes.length - 1;
    }
    this.nextNodeIndex = maxIndex + 1;
  }

  private getPersistedCanvasState(): NoteTestStateRecoveryResult {
    const rawState = this.workspaceState.get<unknown>(NOTE_TEST_STATE_KEY);
    return normalizePersistedStateWithRecovery(rawState);
  }

  private createTicketNode(issue: IssueDetails, requestedIssueKey?: string, x?: number, y?: number): TicketNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 4;
    const row = Math.floor(index / 4);
    const issueKey = (issue.key || requestedIssueKey || '').trim();
    if (!issueKey) {
      throw new Error('Issue details are missing a valid issue key.');
    }

    return {
      type: 'ticket',
      id: `ticket-${issueKey}-${index}`,
      issueKey,
      summary: issue.summary || issueKey,
      issueType: issue.issueType || 'Unknown',
      status: issue.status || 'Unknown',
      assignee: issue.assignee,
      priority: issue.priority,
      projectKey: issue.projectKey || (/^([A-Za-z]\w+)-\d+$/.exec(issueKey)?.[1] ?? 'UNKNOWN'),
      x: x === undefined ? (24 + (column * 280)) : Math.round(x),
      y: y === undefined ? (72 + (row * 160)) : Math.round(y)
    };
  }

  private async handleAddTicketMessage(message: Record<string, unknown>): Promise<void> {
    const issueKey = asString(message.issueKey)?.trim();
    const x = asNumber(message.x);
    const y = asNumber(message.y);

    if (!issueKey) {
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: false,
        error: 'Enter a ticket number before adding.'
      });
      return;
    }

    try {
      const issue = await this.backendService.getIssue(issueKey);
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: true,
        node: this.createTicketNode(issue, issueKey, x, y)
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getHtml(nonce: string, initialState: NoteTestState): string {
    const initialStateLiteral = JSON.stringify(initialState)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Note Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      height: 100vh;
      overflow: hidden;
    }
    .shell {
      height: 100%;
      width: 100%;
    }
    .toolbar-feedback {
      font-size: 12px;
      color: var(--vscode-editor-foreground, #ccc);
      min-height: 0;
      padding: 10px 14px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 86%, transparent);
      border-radius: 12px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 84%, transparent);
      backdrop-filter: blur(12px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toolbar-feedback.error {
      color: var(--vscode-errorForeground, #f44);
      border-color: color-mix(in oklab, var(--vscode-errorForeground, #f44) 38%, var(--vscode-panel-border, #333));
    }
    .toolbar-feedback.has-message {
      opacity: 1;
      transform: translateY(0);
    }

    .canvas-surface {
      height: 100%;
      background-color: var(--vscode-editor-background, #1e1e1e);
      background-image: radial-gradient(circle, var(--vscode-editorIndentGuide-background, #3b3b3b) 1px, transparent 1.5px);
      background-size: 20px 20px;
      position: relative;
      overflow: auto;
      isolation: isolate;
    }

    .canvas-toolbar {
      position: absolute;
      top: 16px;
      left: 16px;
      z-index: 4;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px 8px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 88%, transparent);
      border-radius: 22px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 86%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
    }
    .canvas-toolbar-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 22px;
      margin: 0 auto 2px;
      border-radius: 999px;
      color: var(--vscode-descriptionForeground, #999);
      cursor: grab;
      touch-action: none;
    }
    .canvas-toolbar-handle:active { cursor: grabbing; }
    .canvas-toolbar-grip {
      width: 18px;
      height: 4px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--vscode-descriptionForeground, #999) 72%, transparent);
      box-shadow: 0 6px 0 color-mix(in oklab, var(--vscode-descriptionForeground, #999) 48%, transparent);
    }
    .canvas-toolbar-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .canvas-toolbar-separator {
      width: 100%;
      height: 1px;
      background: color-mix(in oklab, var(--vscode-panel-border, #333) 72%, transparent);
    }
    .overlay-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 14px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-editor-foreground, #ccc));
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    .overlay-icon-button:hover {
      background: color-mix(in oklab, var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #2a2d2e)) 78%, transparent);
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 24%, var(--vscode-panel-border, #333));
      transform: translateY(-1px);
    }
    .overlay-icon-button.is-active {
      background: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 18%, var(--vscode-editorWidget-background, #252526));
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 56%, var(--vscode-panel-border, #333));
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #007fd4));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 18%, transparent);
    }
    .overlay-icon-button:disabled {
      opacity: 0.45;
      cursor: default;
      transform: none;
    }
    .overlay-icon-button svg {
      width: 18px;
      height: 18px;
      display: block;
      color: inherit;
    }
    .overlay-icon-button--accent {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .overlay-icon-button--accent:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
      border-color: transparent;
    }

    .canvas-ticket-entry {
      position: absolute;
      top: 16px;
      left: 88px;
      z-index: 4;
      display: none;
      align-items: center;
      gap: 8px;
      width: min(336px, calc(100% - 136px));
      padding: 10px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 88%, transparent);
      border-radius: 18px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 90%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22);
    }
    .canvas-ticket-entry.is-open {
      display: flex;
    }
    .canvas-ticket-entry input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #333));
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border-radius: 12px;
      padding: 9px 12px;
      font-size: 12px;
    }

    .feedback-overlay {
      position: absolute;
      top: 16px;
      left: 50%;
      z-index: 5;
      width: min(420px, calc(100% - 180px));
      transform: translateX(-50%);
    }

    .nodes-layer {
      position: absolute;
      inset: 0;
      z-index: 1;
      transform-origin: top left;
    }
    .connectors-layer {
      position: absolute;
      inset: 0;
      z-index: 0;
      overflow: visible;
      pointer-events: none;
      transform-origin: top left;
    }
    .connector-group {
      pointer-events: auto;
    }
    .connector-line {
      fill: none;
      stroke: var(--vscode-descriptionForeground, #888);
      stroke-width: 2;
      marker-end: url(#note-test-arrowhead);
      pointer-events: none;
    }
    .connector-hit-area {
      fill: none;
      stroke: transparent;
      stroke-width: 12;
      cursor: pointer;
      pointer-events: stroke;
    }
    .connector-preview-line {
      fill: none;
      stroke: var(--vscode-focusBorder, #007fd4);
      stroke-width: 2.5;
      stroke-dasharray: 7 6;
      opacity: 0.9;
      pointer-events: none;
      marker-end: url(#note-test-arrowhead-preview);
    }
    .connector-group.is-selected .connector-line {
      stroke: var(--vscode-focusBorder, #007fd4);
      stroke-width: 3;
      marker-end: url(#note-test-arrowhead-selected);
    }

    .surface-hint {
      position: absolute;
      top: 16px;
      left: 88px;
      z-index: 2;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-descriptionForeground, #999);
      font-size: 12px;
      pointer-events: none;
    }

    .ticket-node {
      position: absolute;
      min-width: 220px;
      max-width: 420px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--vscode-panel-border, #444);
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
      user-select: none;
      cursor: grab;
      overflow: hidden;
      color: var(--vscode-editor-foreground, #ccc);
    }
    .ticket-node.dragging { cursor: grabbing; }
    .ticket-node.is-resizing { cursor: nwse-resize; }
    .ticket-node.is-selected {
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 82%, var(--vscode-panel-border, #444));
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 28%, transparent), 0 12px 24px rgba(0, 0, 0, 0.18);
    }

    .ticket-node-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin: -10px -10px 8px;
      padding: 6px 10px 5px;
      color: #eff6ff;
      cursor: move;
    }
    .ticket-node-header--ticket {
      background: linear-gradient(135deg, #2b7cd3 0%, #1f5ea3 100%);
    }
    .ticket-node-header--note {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    }
    .ticket-node-header--website {
      background: linear-gradient(135deg, #6eb2ff 0%, #367fdd 100%);
    }
    .ticket-node-title-wrap {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .ticket-node-key {
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: inherit;
      opacity: 0.9;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ticket-node-delete {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.1);
      color: #eff6ff;
      border-radius: 6px;
      cursor: pointer;
    }
    .ticket-node-delete:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .ticket-node-summary {
      margin-top: 6px;
      font-weight: 600;
      line-height: 1.35;
      font-size: 12px;
    }
    .ticket-node-meta {
      margin-top: 8px;
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
    }
    .ticket-node-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .note-node-title-input {
      width: 100%;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      outline: none;
      padding: 0;
      cursor: text;
    }
    .note-node-title-input.is-readonly {
      cursor: grab;
      pointer-events: none;
      user-select: none;
    }
    .note-node-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      margin-top: 6px;
    }
    .note-node-textarea {
      width: 100%;
      min-height: 0;
      height: 100%;
      flex: 1;
      resize: none;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
      color: var(--vscode-editor-foreground, #ccc);
      padding: 10px 11px;
      font: inherit;
      line-height: 1.45;
      outline: none;
      cursor: text;
      box-sizing: border-box;
    }

    .website-node-body {
      display: flex;
      flex-direction: column;
      min-height: 150px;
      height: calc(100% - 34px);
      gap: 8px;
      margin-top: 6px;
    }
    .website-node-url-input {
      width: 100%;
      min-width: 0;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
      color: var(--vscode-input-foreground, #ccc);
      padding: 8px 10px;
      font: inherit;
      outline: none;
      cursor: text;
    }
    .website-node-frame-wrap {
      position: relative;
      flex: 1;
      min-height: 120px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      overflow: hidden;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 96%, transparent);
    }
    .website-node-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: white;
    }
    .website-node-empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #999);
      font-size: 12px;
      line-height: 1.45;
    }

    .note-node-resize-handle {
      position: absolute;
      right: 6px;
      bottom: 6px;
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      background: transparent;
      cursor: nwse-resize;
      z-index: 2;
    }
    .note-node-resize-handle::before {
      content: '';
      position: absolute;
      inset: 3px;
      border-right: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground, #999) 86%, transparent);
      border-bottom: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground, #999) 86%, transparent);
      border-bottom-right-radius: 2px;
    }

    .ticket-node-handle {
      --handle-transform: translate(-50%, -50%);
      position: absolute;
      width: 14px;
      height: 14px;
      padding: 0;
      border: 2px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 999px;
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-panel-border, #333) 72%, transparent);
      opacity: 0;
      pointer-events: none;
      z-index: 3;
      cursor: crosshair;
      transform: var(--handle-transform) scale(0.72);
      transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
    }
    .ticket-node-handle--top { top: 0; left: 50%; --handle-transform: translate(-50%, -50%); }
    .ticket-node-handle--right { top: 50%; right: 0; --handle-transform: translate(50%, -50%); }
    .ticket-node-handle--bottom { bottom: 0; left: 50%; --handle-transform: translate(-50%, 50%); }
    .ticket-node-handle--left { top: 50%; left: 0; --handle-transform: translate(-50%, -50%); }
    .ticket-node.is-selected .ticket-node-handle,
    .ticket-node.is-link-target .ticket-node-handle {
      opacity: 1;
      pointer-events: auto;
      transform: var(--handle-transform) scale(1);
    }
    .ticket-node-handle:hover {
      background: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 24%, transparent);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  </style>
</head>
<body>
  <div class="shell">
    <main id="canvas-surface" class="canvas-surface" aria-label="Note Test canvas">
      <div class="canvas-toolbar" aria-label="Note Test tools">
        <div id="canvas-toolbar-handle" class="canvas-toolbar-handle" title="Drag toolbar" aria-label="Drag toolbar">
          <span class="canvas-toolbar-grip" aria-hidden="true"></span>
        </div>
        <div class="canvas-toolbar-group">
          ${renderToolbarButton('toolbar-select-button', 'select', 'Select', 'select')}
          ${renderToolbarButton('toolbar-ticket-button', 'ticket', 'Add ticket', 'ticket')}
          ${renderToolbarButton('toolbar-note-button', 'note', 'Add note', 'note')}
          ${renderToolbarButton('toolbar-website-button', 'website', 'Add website preview', 'website')}
          ${renderToolbarButton('toolbar-link-button', 'link', 'Link components', 'link')}
          ${renderToolbarButton('toolbar-zoom-in-button', 'zoomIn', 'Zoom in', 'zoomIn')}
          ${renderToolbarButton('toolbar-zoom-out-button', 'zoomOut', 'Zoom out', 'zoomOut')}
        </div>
        <div class="canvas-toolbar-separator"></div>
        <div class="canvas-toolbar-group">
          ${renderToolbarButton('delete-connector-button', 'deleteConnector', 'Delete selected link', 'deleteConnector', { disabled: true })}
          ${renderToolbarButton('toolbar-reset-button', 'reset', 'Clear canvas', 'reset')}
        </div>
      </div>

      <form id="ticket-entry-panel" class="canvas-ticket-entry" autocomplete="off">
        <label class="sr-only" for="ticket-key-input">Ticket number</label>
        <input id="ticket-key-input" type="text" placeholder="Ticket number (e.g. APP-123)" aria-label="Ticket number" />
        ${renderToolbarButton('ticket-add-button', undefined, 'Confirm add ticket', 'confirm', { extraClass: 'overlay-icon-button--accent' })}
        ${renderToolbarButton('ticket-entry-close-button', undefined, 'Close ticket entry', 'dismiss')}
      </form>

      <div class="feedback-overlay">
        <div id="toolbar-feedback" class="toolbar-feedback" aria-live="polite"></div>
      </div>

      <svg id="connectors-layer" class="connectors-layer" aria-hidden="true">
        <defs>
          <marker id="note-test-arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-descriptionForeground, #888)"></polygon>
          </marker>
          <marker id="note-test-arrowhead-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder, #007fd4)"></polygon>
          </marker>
          <marker id="note-test-arrowhead-preview" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder, #007fd4)"></polygon>
          </marker>
        </defs>
      </svg>

      <div id="nodes-layer" class="nodes-layer"></div>
      <div id="surface-hint" class="surface-hint">Add tickets, notes, or website previews to start building.</div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const initialState = ${initialStateLiteral};

    const canvasSurface = document.getElementById('canvas-surface');
    const nodesLayer = document.getElementById('nodes-layer');
    const connectorsLayer = document.getElementById('connectors-layer');
    const canvasToolbar = document.querySelector('.canvas-toolbar');
    const canvasToolbarHandle = document.getElementById('canvas-toolbar-handle');
    const surfaceHint = document.getElementById('surface-hint');
    const feedback = document.getElementById('toolbar-feedback');

    const ticketInput = document.getElementById('ticket-key-input');
    const ticketEntryPanel = document.getElementById('ticket-entry-panel');
    const ticketAddButton = document.getElementById('ticket-add-button');
    const ticketEntryCloseButton = document.getElementById('ticket-entry-close-button');
    const deleteConnectorButton = document.getElementById('delete-connector-button');

    const state = {
      nodes: Array.isArray(initialState.nodes) ? initialState.nodes : [],
      connectors: Array.isArray(initialState.connectors) ? initialState.connectors : []
    };

    let feedbackTimer = undefined;
    const uiState = {
      activeTool: 'select',
      linkSourceNodeId: undefined,
      selectedNodeId: undefined,
      editingNoteTitleId: undefined,
      selectedConnectorId: undefined,
      nextConnectorIndex: state.connectors.length,
      ticketEntryOpen: false,
      toolbarPosition: {
        x: typeof initialState.toolbarPosition?.x === 'number' ? initialState.toolbarPosition.x : 16,
        y: typeof initialState.toolbarPosition?.y === 'number' ? initialState.toolbarPosition.y : 16
      },
      zoom: typeof initialState.zoom === 'number' ? initialState.zoom : 1,
      linkPreview: undefined,
      hoveredLinkNodeId: undefined,
      persistCanvasStateTimer: undefined,
      toolbarDrag: undefined
    };

    function setFeedback(text, isError) {
      if (!(feedback instanceof HTMLElement)) {
        return;
      }
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = undefined;
      }
      feedback.textContent = text || '';
      feedback.classList.toggle('error', Boolean(isError));
      feedback.classList.toggle('has-message', Boolean(text));
      if (text) {
        feedbackTimer = setTimeout(() => {
          feedback.textContent = '';
          feedback.classList.remove('error', 'has-message');
        }, 3000);
      }
    }

    function normalizeWebsitePreviewUrl(raw) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (!trimmed) {
        return undefined;
      }
      const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : ('https://' + trimmed);
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return undefined;
        }
        return url.toString();
      } catch {
        return undefined;
      }
    }

    function websitePreviewTitle(url) {
      const normalized = normalizeWebsitePreviewUrl(url);
      if (!normalized) {
        return 'Website Preview';
      }
      try {
        const parsed = new URL(normalized);
        return parsed.hostname || 'Website Preview';
      } catch {
        return 'Website Preview';
      }
    }

    function getNodeLabel(node) {
      if (!node) {
        return 'selected node';
      }
      if (node.type === 'note') {
        return (typeof node.title === 'string' && node.title.trim()) ? node.title.trim() : 'note';
      }
      if (node.type === 'website') {
        return websitePreviewTitle(node.url);
      }
      return node.issueKey || 'ticket';
    }

    function persistCanvasState() {
      vscodeApi.postMessage({
        type: 'persistCanvasState',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector })),
          zoom: uiState.zoom,
          toolbarPosition: { x: uiState.toolbarPosition.x, y: uiState.toolbarPosition.y }
        }
      });
    }

    function schedulePersistCanvasState() {
      if (uiState.persistCanvasStateTimer) {
        clearTimeout(uiState.persistCanvasStateTimer);
      }
      uiState.persistCanvasStateTimer = setTimeout(() => {
        uiState.persistCanvasStateTimer = undefined;
        persistCanvasState();
      }, 160);
    }

    function clampToolbarPosition(position) {
      if (!(canvasSurface instanceof HTMLElement) || !(canvasToolbar instanceof HTMLElement)) {
        return position;
      }
      const minX = canvasSurface.scrollLeft + 8;
      const minY = canvasSurface.scrollTop + 8;
      const maxX = canvasSurface.scrollLeft + canvasSurface.clientWidth - canvasToolbar.offsetWidth - 8;
      const maxY = canvasSurface.scrollTop + canvasSurface.clientHeight - canvasToolbar.offsetHeight - 8;
      return {
        x: Math.max(minX, Math.min(position.x, Math.max(minX, maxX))),
        y: Math.max(minY, Math.min(position.y, Math.max(minY, maxY)))
      };
    }

    function syncFloatingLayout() {
      if (canvasToolbar instanceof HTMLElement) {
        const position = clampToolbarPosition(uiState.toolbarPosition);
        uiState.toolbarPosition = position;
        canvasToolbar.style.left = position.x + 'px';
        canvasToolbar.style.top = position.y + 'px';
      }
      if (ticketEntryPanel instanceof HTMLElement) {
        ticketEntryPanel.style.left = (uiState.toolbarPosition.x + 72) + 'px';
        ticketEntryPanel.style.top = uiState.toolbarPosition.y + 'px';
      }
      if (surfaceHint instanceof HTMLElement) {
        surfaceHint.style.left = (uiState.toolbarPosition.x + 72) + 'px';
        surfaceHint.style.top = uiState.toolbarPosition.y + 'px';
      }
      if (nodesLayer instanceof HTMLElement) {
        nodesLayer.style.transformOrigin = 'top left';
        nodesLayer.style.transform = 'scale(' + uiState.zoom + ')';
      }
      if (connectorsLayer instanceof SVGElement) {
        connectorsLayer.style.transformOrigin = 'top left';
        connectorsLayer.style.transform = 'scale(' + uiState.zoom + ')';
      }
    }

    function clientDistanceToCanvas(distance) {
      return distance / uiState.zoom;
    }

    function clientPointToCanvas(clientX, clientY) {
      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      return {
        x: clientDistanceToCanvas(clientX - nodeLayerRect.left),
        y: clientDistanceToCanvas(clientY - nodeLayerRect.top)
      };
    }

    function visibleCanvasPoint(offsetX, offsetY) {
      if (!(canvasSurface instanceof HTMLElement)) {
        return { x: offsetX, y: offsetY };
      }
      return {
        x: clientDistanceToCanvas(canvasSurface.scrollLeft + offsetX),
        y: clientDistanceToCanvas(canvasSurface.scrollTop + offsetY)
      };
    }

    function setZoom(nextZoom) {
      uiState.zoom = Math.max(0.5, Math.min(2, Math.round(nextZoom * 100) / 100));
      syncFloatingLayout();
      renderConnectors();
      schedulePersistCanvasState();
      setFeedback('Zoom ' + Math.round(uiState.zoom * 100) + '%.');
    }

    function syncToolbarState() {
      for (const button of document.querySelectorAll('button[data-action]')) {
        const action = button.getAttribute('data-action');
        const isActive = action === uiState.activeTool || (action === 'ticket' && uiState.ticketEntryOpen);
        button.classList.toggle('is-active', Boolean(isActive));
      }
    }

    function setTicketEntryOpen(isOpen, options) {
      uiState.ticketEntryOpen = Boolean(isOpen);
      if (ticketEntryPanel instanceof HTMLElement) {
        ticketEntryPanel.hidden = !uiState.ticketEntryOpen;
        ticketEntryPanel.classList.toggle('is-open', uiState.ticketEntryOpen);
      }
      syncToolbarState();
      syncFloatingLayout();
      if (uiState.ticketEntryOpen && options && options.focus && ticketInput instanceof HTMLInputElement) {
        requestAnimationFrame(() => ticketInput.focus());
      }
    }

    function isLinkHandleDirection(value) {
      return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
    }

    function findNodeById(nodeId) {
      return state.nodes.find(node => node.id === nodeId);
    }

    function hasNode(nodeId) {
      return state.nodes.some(node => node.id === nodeId);
    }

    function hasExistingConnector(sourceNodeId, targetNodeId) {
      return state.connectors.some(connector => connector.sourceNodeId === sourceNodeId && connector.targetNodeId === targetNodeId);
    }

    function hasDirectedPath(startNodeId, targetNodeId) {
      const stack = [startNodeId];
      const visited = new Set();
      while (stack.length > 0) {
        const nodeId = stack.pop();
        if (!nodeId || visited.has(nodeId)) {
          continue;
        }
        if (nodeId === targetNodeId) {
          return true;
        }
        visited.add(nodeId);
        for (const connector of state.connectors) {
          if (connector.sourceNodeId === nodeId && !visited.has(connector.targetNodeId)) {
            stack.push(connector.targetNodeId);
          }
        }
      }
      return false;
    }

    function wouldCreateCycle(sourceNodeId, targetNodeId) {
      return hasDirectedPath(targetNodeId, sourceNodeId);
    }

    function setActiveTool(tool) {
      uiState.activeTool = tool;
      if (tool !== 'link') {
        clearLinkPreview();
      }
      syncToolbarState();
    }

    function syncNodeInteractionClasses() {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const nodeId = element.dataset.nodeId;
        element.classList.toggle('is-selected', Boolean(nodeId && nodeId === uiState.selectedNodeId));
        element.classList.toggle('is-link-target', Boolean(nodeId && nodeId === uiState.hoveredLinkNodeId));
      }
    }

    function setHoveredLinkNode(nodeId) {
      const nextNodeId = typeof nodeId === 'string' && nodeId ? nodeId : undefined;
      if (uiState.hoveredLinkNodeId === nextNodeId) {
        return;
      }
      uiState.hoveredLinkNodeId = nextNodeId;
      syncNodeInteractionClasses();
    }

    function clearLinkPreview() {
      uiState.linkPreview = undefined;
      uiState.linkSourceNodeId = undefined;
      setHoveredLinkNode(undefined);
      renderConnectors();
    }

    function createConnectorId() {
      const id = 'connector-' + uiState.nextConnectorIndex;
      uiState.nextConnectorIndex += 1;
      return id;
    }

    function createConnectorBetweenNodes(sourceNodeId, targetNodeId, sourceDirection, targetDirection) {
      if (sourceNodeId === targetNodeId) {
        setFeedback('Select a different target component.', true);
        return false;
      }
      if (hasExistingConnector(sourceNodeId, targetNodeId)) {
        setFeedback('Link already exists.', true);
        return false;
      }
      if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
        setFeedback('Cannot create link: this introduces a cycle.', true);
        return false;
      }

      state.connectors.push({
        id: createConnectorId(),
        sourceNodeId,
        targetNodeId,
        sourceDirection,
        targetDirection
      });
      uiState.selectedConnectorId = state.connectors[state.connectors.length - 1]?.id;
      uiState.selectedNodeId = targetNodeId;
      clearLinkPreview();
      renderNodes();
      persistCanvasState();
      setFeedback('Directed link created.');
      updateDeleteConnectorState();
      return true;
    }

    function getAnchorPointFromRect(nodeRect, nodeLayerRect, direction) {
      const centerX = clientDistanceToCanvas(nodeRect.left - nodeLayerRect.left + (nodeRect.width / 2));
      const centerY = clientDistanceToCanvas(nodeRect.top - nodeLayerRect.top + (nodeRect.height / 2));
      switch (direction) {
        case 'top':
          return { x: centerX, y: clientDistanceToCanvas(nodeRect.top - nodeLayerRect.top) };
        case 'right':
          return { x: clientDistanceToCanvas(nodeRect.right - nodeLayerRect.left), y: centerY };
        case 'bottom':
          return { x: centerX, y: clientDistanceToCanvas(nodeRect.bottom - nodeLayerRect.top) };
        case 'left':
        default:
          return { x: clientDistanceToCanvas(nodeRect.left - nodeLayerRect.left), y: centerY };
      }
    }

    function resolveConnectorDirections(sourceRect, targetRect, sourceDirection, targetDirection) {
      if (isLinkHandleDirection(sourceDirection) && isLinkHandleDirection(targetDirection)) {
        return { sourceDirection, targetDirection };
      }
      const sourceCenterX = sourceRect.left + (sourceRect.width / 2);
      const sourceCenterY = sourceRect.top + (sourceRect.height / 2);
      const targetCenterX = targetRect.left + (targetRect.width / 2);
      const targetCenterY = targetRect.top + (targetRect.height / 2);
      const deltaX = targetCenterX - sourceCenterX;
      const deltaY = targetCenterY - sourceCenterY;
      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        return {
          sourceDirection: isLinkHandleDirection(sourceDirection) ? sourceDirection : (deltaX >= 0 ? 'right' : 'left'),
          targetDirection: isLinkHandleDirection(targetDirection) ? targetDirection : (deltaX >= 0 ? 'left' : 'right')
        };
      }
      return {
        sourceDirection: isLinkHandleDirection(sourceDirection) ? sourceDirection : (deltaY >= 0 ? 'bottom' : 'top'),
        targetDirection: isLinkHandleDirection(targetDirection) ? targetDirection : (deltaY >= 0 ? 'top' : 'bottom')
      };
    }

    function buildConnectorCurvePath(x1, y1, x2, y2, sourceDirection, targetDirection) {
      const horizontalDelta = Math.abs(x2 - x1);
      const verticalDelta = Math.abs(y2 - y1);
      const controlOffset = Math.max(42, Math.min(Math.max(horizontalDelta, verticalDelta) * 0.42, 164));
      const controlPointFromDirection = (x, y, direction) => {
        switch (direction) {
          case 'top':
            return { x, y: y - controlOffset };
          case 'right':
            return { x: x + controlOffset, y };
          case 'bottom':
            return { x, y: y + controlOffset };
          case 'left':
            return { x: x - controlOffset, y };
          default:
            return { x: x + controlOffset, y };
        }
      };
      const control1 = controlPointFromDirection(x1, y1, sourceDirection);
      const control2 = controlPointFromDirection(x2, y2, targetDirection);
      return 'M ' + x1 + ' ' + y1 + ' C ' + control1.x + ' ' + control1.y + ', ' + control2.x + ' ' + control2.y + ', ' + x2 + ' ' + y2;
    }

    function nodeElementById(nodeId) {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (element instanceof HTMLElement && element.dataset.nodeId === nodeId) {
          return element;
        }
      }
      return undefined;
    }

    function renderConnectors() {
      for (const element of connectorsLayer.querySelectorAll('.connector-group, .connector-preview-line')) {
        element.remove();
      }
      if (uiState.selectedConnectorId && !state.connectors.some(connector => connector.id === uiState.selectedConnectorId)) {
        uiState.selectedConnectorId = undefined;
      }

      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      for (const connector of state.connectors) {
        const sourceEl = nodeElementById(connector.sourceNodeId);
        const targetEl = nodeElementById(connector.targetNodeId);
        if (!(sourceEl instanceof HTMLElement) || !(targetEl instanceof HTMLElement)) {
          continue;
        }

        const sourceRect = sourceEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const directions = resolveConnectorDirections(sourceRect, targetRect, connector.sourceDirection, connector.targetDirection);
        const sourcePoint = getAnchorPointFromRect(sourceRect, nodeLayerRect, directions.sourceDirection);
        const targetPoint = getAnchorPointFromRect(targetRect, nodeLayerRect, directions.targetDirection);
        const pathData = buildConnectorCurvePath(sourcePoint.x, sourcePoint.y, targetPoint.x, targetPoint.y, directions.sourceDirection, directions.targetDirection);

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'connector-group' + (uiState.selectedConnectorId === connector.id ? ' is-selected' : ''));
        group.dataset.connectorId = connector.id;

        const visibleLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        visibleLine.setAttribute('class', 'connector-line');
        visibleLine.setAttribute('d', pathData);

        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('class', 'connector-hit-area');
        hitArea.setAttribute('d', pathData);
        hitArea.addEventListener('click', event => {
          event.stopPropagation();
          uiState.selectedConnectorId = connector.id;
          updateDeleteConnectorState();
          renderConnectors();
        });

        group.append(visibleLine, hitArea);
        connectorsLayer.append(group);
      }

      if (uiState.linkPreview) {
        const previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        previewLine.setAttribute('class', 'connector-preview-line');
        const previewTargetDirection = isLinkHandleDirection(uiState.linkPreview.targetDirection)
          ? uiState.linkPreview.targetDirection
          : (() => {
            const deltaX = uiState.linkPreview.x2 - uiState.linkPreview.x1;
            const deltaY = uiState.linkPreview.y2 - uiState.linkPreview.y1;
            return Math.abs(deltaX) >= Math.abs(deltaY)
              ? (deltaX >= 0 ? 'left' : 'right')
              : (deltaY >= 0 ? 'top' : 'bottom');
          })();

        previewLine.setAttribute(
          'd',
          buildConnectorCurvePath(
            uiState.linkPreview.x1,
            uiState.linkPreview.y1,
            uiState.linkPreview.x2,
            uiState.linkPreview.y2,
            uiState.linkPreview.sourceDirection,
            previewTargetDirection
          )
        );
        connectorsLayer.append(previewLine);
      }

      updateDeleteConnectorState();
    }

    function createMetaRow(label, value) {
      const row = document.createElement('div');
      row.className = 'ticket-node-meta-row';
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      right.textContent = value || '-';
      row.append(left, right);
      return row;
    }

    function findHandleTargetAtPoint(clientX, clientY) {
      const targetElement = document.elementFromPoint(clientX, clientY);
      if (!(targetElement instanceof Element)) {
        return undefined;
      }
      const handleElement = targetElement.closest('.ticket-node-handle');
      if (!(handleElement instanceof HTMLElement)) {
        return undefined;
      }
      const nodeId = handleElement.dataset.nodeId;
      const direction = handleElement.dataset.direction;
      if (!nodeId || !isLinkHandleDirection(direction)) {
        return undefined;
      }
      return { nodeId, direction };
    }

    function findNodeIdAtPoint(clientX, clientY) {
      const targetElement = document.elementFromPoint(clientX, clientY);
      if (!(targetElement instanceof Element)) {
        return undefined;
      }
      const nodeElement = targetElement.closest('[data-node-id]');
      return nodeElement instanceof HTMLElement ? nodeElement.dataset.nodeId : undefined;
    }

    function updateLinkPreviewFromPointer(event) {
      if (!uiState.linkPreview) {
        return;
      }
      const sourceElement = nodeElementById(uiState.linkPreview.sourceNodeId);
      if (!(sourceElement instanceof HTMLElement)) {
        clearLinkPreview();
        return;
      }
      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      const sourceRect = sourceElement.getBoundingClientRect();
      const sourcePoint = getAnchorPointFromRect(sourceRect, nodeLayerRect, uiState.linkPreview.sourceDirection);
      const targetHandle = findHandleTargetAtPoint(event.clientX, event.clientY);
      const hoveredNodeId = targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId
        ? targetHandle.nodeId
        : (() => {
          const nodeId = findNodeIdAtPoint(event.clientX, event.clientY);
          return nodeId && nodeId !== uiState.linkPreview.sourceNodeId ? nodeId : undefined;
        })();

      uiState.linkPreview.x1 = sourcePoint.x;
      uiState.linkPreview.y1 = sourcePoint.y;
      if (targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId) {
        const targetElement = nodeElementById(targetHandle.nodeId);
        if (targetElement instanceof HTMLElement) {
          const targetRect = targetElement.getBoundingClientRect();
          const targetPoint = getAnchorPointFromRect(targetRect, nodeLayerRect, targetHandle.direction);
          uiState.linkPreview.x2 = targetPoint.x;
          uiState.linkPreview.y2 = targetPoint.y;
          uiState.linkPreview.targetDirection = targetHandle.direction;
        }
      } else {
        const previewPoint = clientPointToCanvas(event.clientX, event.clientY);
        uiState.linkPreview.x2 = previewPoint.x;
        uiState.linkPreview.y2 = previewPoint.y;
        uiState.linkPreview.targetDirection = undefined;
      }
      setHoveredLinkNode(hoveredNodeId);
    }

    function renderNodes() {
      if (!(nodesLayer instanceof HTMLElement)) {
        return;
      }
      nodesLayer.textContent = '';
      if (surfaceHint instanceof HTMLElement) {
        surfaceHint.style.display = state.nodes.length > 0 ? 'none' : '';
      }

      for (const node of state.nodes) {
        const root = document.createElement('article');
        root.className = 'ticket-node ticket-node--' + node.type;
        root.style.left = node.x + 'px';
        root.style.top = node.y + 'px';
        if (node.type === 'note' || node.type === 'website') {
          root.style.width = node.width + 'px';
          root.style.height = node.height + 'px';
        }
        root.dataset.nodeId = node.id;
        root.classList.toggle('is-selected', uiState.selectedNodeId === node.id);
        root.classList.toggle('is-link-target', uiState.hoveredLinkNodeId === node.id);

        const header = document.createElement('div');
        header.className = 'ticket-node-header ticket-node-header--' + node.type;

        const titleWrap = document.createElement('div');
        titleWrap.className = 'ticket-node-title-wrap';

        if (node.type === 'note') {
          const isTitleEditing = uiState.editingNoteTitleId === node.id;
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'note-node-title-input';
          if (!isTitleEditing) {
            titleInput.classList.add('is-readonly');
          }
          titleInput.value = node.title || '';
          titleInput.placeholder = 'Notes';
          titleInput.setAttribute('aria-label', 'Note title');
          titleInput.readOnly = !isTitleEditing;
          titleInput.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          titleInput.addEventListener('click', event => {
            event.stopPropagation();
          });
          titleInput.addEventListener('blur', () => {
            if (uiState.editingNoteTitleId === node.id) {
              uiState.editingNoteTitleId = undefined;
              renderNodes();
            }
          });
          titleInput.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              titleInput.blur();
            }
          });
          titleInput.addEventListener('input', () => {
            node.title = titleInput.value;
            schedulePersistCanvasState();
          });
          titleWrap.addEventListener('dblclick', event => {
            event.stopPropagation();
            uiState.editingNoteTitleId = node.id;
            renderNodes();
            requestAnimationFrame(() => {
              const refreshedInput = nodesLayer.querySelector('[data-node-id="' + node.id + '"] .note-node-title-input');
              if (refreshedInput instanceof HTMLInputElement) {
                refreshedInput.focus();
                refreshedInput.select();
              }
            });
          });
          titleWrap.append(titleInput);
        } else if (node.type === 'website') {
          const key = document.createElement('div');
          key.className = 'ticket-node-key';
          key.textContent = websitePreviewTitle(node.url);
          titleWrap.append(key);
        } else {
          const key = document.createElement('div');
          key.className = 'ticket-node-key';
          key.textContent = node.issueKey;
          titleWrap.append(key);
        }

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'ticket-node-delete';
        deleteButton.setAttribute('aria-label', 'Delete ' + getNodeLabel(node));
        deleteButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 4.5 11.5 11.5M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        deleteButton.addEventListener('click', event => {
          event.stopPropagation();
          state.nodes = state.nodes.filter(item => item.id !== node.id);
          state.connectors = state.connectors.filter(connector => connector.sourceNodeId !== node.id && connector.targetNodeId !== node.id);
          if (uiState.selectedNodeId === node.id) {
            uiState.selectedNodeId = undefined;
          }
          if (uiState.editingNoteTitleId === node.id) {
            uiState.editingNoteTitleId = undefined;
          }
          if (uiState.linkSourceNodeId === node.id) {
            clearLinkPreview();
          }
          renderNodes();
          persistCanvasState();
          setFeedback(getNodeLabel(node) + ' deleted.');
        });

        header.append(titleWrap, deleteButton);

        let resizeHandle = null;
        if (node.type === 'ticket') {
          const summary = document.createElement('div');
          summary.className = 'ticket-node-summary';
          summary.textContent = node.summary || '(no summary)';

          const meta = document.createElement('div');
          meta.className = 'ticket-node-meta';
          meta.append(
            createMetaRow('Type', node.issueType),
            createMetaRow('Status', node.status),
            createMetaRow('Assignee', node.assignee),
            createMetaRow('Priority', node.priority)
          );

          root.append(header, summary, meta);
        } else if (node.type === 'note') {
          const body = document.createElement('div');
          body.className = 'note-node-body';

          const textarea = document.createElement('textarea');
          textarea.className = 'note-node-textarea';
          textarea.placeholder = 'Add notes, context, or reminders...';
          textarea.value = node.content || '';
          textarea.setAttribute('aria-label', 'Note content');
          textarea.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          textarea.addEventListener('click', event => {
            event.stopPropagation();
          });
          textarea.addEventListener('input', () => {
            node.content = textarea.value;
            schedulePersistCanvasState();
          });

          body.append(textarea);

          resizeHandle = document.createElement('button');
          resizeHandle.type = 'button';
          resizeHandle.className = 'note-node-resize-handle';
          resizeHandle.setAttribute('aria-label', 'Resize note');

          root.append(header, body, resizeHandle);
        } else {
          const body = document.createElement('div');
          body.className = 'website-node-body';

          const urlInput = document.createElement('input');
          urlInput.type = 'url';
          urlInput.className = 'website-node-url-input';
          urlInput.value = node.url || '';
          urlInput.placeholder = 'https://example.com';
          urlInput.setAttribute('aria-label', 'Website URL');
          urlInput.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          urlInput.addEventListener('click', event => {
            event.stopPropagation();
          });

          const frameWrap = document.createElement('div');
          frameWrap.className = 'website-node-frame-wrap';

          const updateWebsitePreview = () => {
            const normalized = normalizeWebsitePreviewUrl(urlInput.value);
            if (!normalized) {
              frameWrap.innerHTML = '<div class="website-node-empty">Enter a valid http or https URL to load a preview.</div>';
              return;
            }
            node.url = normalized;
            const iframe = document.createElement('iframe');
            iframe.className = 'website-node-frame';
            iframe.src = normalized;
            iframe.setAttribute('title', websitePreviewTitle(normalized));
            iframe.setAttribute('referrerpolicy', 'no-referrer');
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
            frameWrap.replaceChildren(iframe);
            titleWrap.textContent = '';
            const key = document.createElement('div');
            key.className = 'ticket-node-key';
            key.textContent = websitePreviewTitle(normalized);
            titleWrap.append(key);
            schedulePersistCanvasState();
          };

          urlInput.addEventListener('change', updateWebsitePreview);
          urlInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              updateWebsitePreview();
            }
          });
          updateWebsitePreview();

          body.append(urlInput, frameWrap);

          resizeHandle = document.createElement('button');
          resizeHandle.type = 'button';
          resizeHandle.className = 'note-node-resize-handle';
          resizeHandle.setAttribute('aria-label', 'Resize website preview');

          root.append(header, body, resizeHandle);
        }

        for (const direction of ['top', 'right', 'bottom', 'left']) {
          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = 'ticket-node-handle ticket-node-handle--' + direction;
          handle.dataset.nodeId = node.id;
          handle.dataset.direction = direction;
          handle.setAttribute('aria-label', 'Create link from ' + getNodeLabel(node) + ' ' + direction);
          handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            uiState.linkSourceNodeId = node.id;
            uiState.linkPreview = {
              sourceNodeId: node.id,
              sourceDirection: direction,
              targetDirection: undefined,
              pointerId: event.pointerId,
              x1: 0,
              y1: 0,
              x2: 0,
              y2: 0
            };
            root.setPointerCapture(event.pointerId);
            updateLinkPreviewFromPointer(event);
            syncNodeInteractionClasses();
            renderConnectors();
            updateDeleteConnectorState();
            setFeedback('Drag to another connector to create a directed link.');
          });
          root.append(handle);
        }

        let dragging = null;
        let resizing = null;

        if (resizeHandle) {
          resizeHandle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || (node.type !== 'note' && node.type !== 'website')) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            resizing = {
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startWidth: node.width,
              startHeight: node.height
            };
            root.classList.add('is-resizing');
            root.setPointerCapture(event.pointerId);
            syncNodeInteractionClasses();
            renderConnectors();
          });
        }

        root.addEventListener('pointerdown', event => {
          if (event.button !== 0) {
            return;
          }
          if (event.target instanceof HTMLElement && event.target.closest('button')) {
            return;
          }
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
            return;
          }
          uiState.selectedNodeId = node.id;
          uiState.selectedConnectorId = undefined;
          dragging = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: node.x,
            startY: node.y
          };
          root.classList.add('dragging');
          root.setPointerCapture(event.pointerId);
          syncNodeInteractionClasses();
          renderConnectors();
        });

        root.addEventListener('pointermove', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            updateLinkPreviewFromPointer(event);
            renderConnectors();
            return;
          }
          if (resizing && resizing.pointerId === event.pointerId && (node.type === 'note' || node.type === 'website')) {
            const deltaX = clientDistanceToCanvas(event.clientX - resizing.startClientX);
            const deltaY = clientDistanceToCanvas(event.clientY - resizing.startClientY);
            node.width = Math.max(220, Math.round(resizing.startWidth + deltaX));
            node.height = Math.max(150, Math.round(resizing.startHeight + deltaY));
            root.style.width = node.width + 'px';
            root.style.height = node.height + 'px';
            renderConnectors();
            return;
          }
          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = clientDistanceToCanvas(event.clientX - dragging.startClientX);
          const deltaY = clientDistanceToCanvas(event.clientY - dragging.startClientY);
          node.x = Math.round(dragging.startX + deltaX);
          node.y = Math.round(dragging.startY + deltaY);
          root.style.left = node.x + 'px';
          root.style.top = node.y + 'px';
          renderConnectors();
        });

        root.addEventListener('pointerup', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            root.releasePointerCapture(event.pointerId);
            const targetHandle = findHandleTargetAtPoint(event.clientX, event.clientY);
            if (targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId) {
              createConnectorBetweenNodes(
                uiState.linkPreview.sourceNodeId,
                targetHandle.nodeId,
                uiState.linkPreview.sourceDirection,
                targetHandle.direction
              );
            } else {
              clearLinkPreview();
              setFeedback('Link cancelled. Drop on another connector to create it.');
            }
            return;
          }

          if (resizing && resizing.pointerId === event.pointerId) {
            resizing = null;
            root.classList.remove('is-resizing');
            renderConnectors();
            schedulePersistCanvasState();
            return;
          }

          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          dragging = null;
          root.classList.remove('dragging');
          renderConnectors();
          persistCanvasState();
        });

        root.addEventListener('pointercancel', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            clearLinkPreview();
          }
          if (resizing && resizing.pointerId === event.pointerId) {
            resizing = null;
            root.classList.remove('is-resizing');
            schedulePersistCanvasState();
          }
          if (dragging && dragging.pointerId === event.pointerId) {
            dragging = null;
            root.classList.remove('dragging');
            persistCanvasState();
          }
        });

        nodesLayer.append(root);
      }

      renderConnectors();
      syncNodeInteractionClasses();
    }

    function updateDeleteConnectorState() {
      const hasSelection = Boolean(uiState.selectedConnectorId && state.connectors.some(connector => connector.id === uiState.selectedConnectorId));
      if (deleteConnectorButton instanceof HTMLButtonElement) {
        deleteConnectorButton.disabled = !hasSelection;
      }
    }

    function deleteSelectedConnector() {
      if (!uiState.selectedConnectorId) {
        return;
      }
      const connectorId = uiState.selectedConnectorId;
      const before = state.connectors.length;
      state.connectors = state.connectors.filter(connector => connector.id !== connectorId);
      uiState.selectedConnectorId = undefined;
      if (before !== state.connectors.length) {
        renderConnectors();
        persistCanvasState();
        setFeedback('Link deleted.');
      }
      updateDeleteConnectorState();
    }

    function addNote() {
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      state.nodes.push({
        type: 'note',
        id,
        title: 'Notes',
        content: '',
        x: Math.round(point.x),
        y: Math.round(point.y),
        width: 280,
        height: 190
      });
      uiState.selectedNodeId = id;
      uiState.selectedConnectorId = undefined;
      renderNodes();
      persistCanvasState();
      setFeedback('Note added.');
    }

    function addWebsitePreview() {
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      const id = 'website-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      state.nodes.push({
        type: 'website',
        id,
        url: 'https://',
        x: Math.round(point.x),
        y: Math.round(point.y),
        width: 360,
        height: 260
      });
      uiState.selectedNodeId = id;
      uiState.selectedConnectorId = undefined;
      renderNodes();
      persistCanvasState();
      setFeedback('Website preview added. Enter a URL to load it.');
    }

    function requestAddTicket() {
      const issueKey = ticketInput instanceof HTMLInputElement ? ticketInput.value.trim() : '';
      if (!issueKey) {
        setFeedback('Issue key is required to add a ticket.', true);
        return;
      }
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      vscodeApi.postMessage({ type: 'addTicket', issueKey, x: Math.round(point.x), y: Math.round(point.y) });
      setFeedback('Adding ticket ' + issueKey + '...');
    }

    function requestAddTicketFromDrop(issueKey, dropPoint) {
      const normalizedIssueKey = typeof issueKey === 'string' ? issueKey.trim() : '';
      if (!normalizedIssueKey) {
        setFeedback('Dropped issue key was empty.', true);
        return;
      }
      vscodeApi.postMessage({
        type: 'addTicket',
        issueKey: normalizedIssueKey,
        x: Math.round(dropPoint.x),
        y: Math.round(dropPoint.y)
      });
      setFeedback('Adding dropped ticket ' + normalizedIssueKey + '...');
    }

    function clearCanvas() {
      if (state.nodes.length === 0 && state.connectors.length === 0) {
        setFeedback('Nothing to clear.');
        return;
      }
      state.nodes = [];
      state.connectors = [];
      uiState.selectedNodeId = undefined;
      uiState.selectedConnectorId = undefined;
      clearLinkPreview();
      renderNodes();
      persistCanvasState();
      setFeedback('Canvas cleared.');
    }

    for (const button of document.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        if (action === 'select') {
          setActiveTool('select');
          return;
        }
        if (action === 'ticket') {
          setTicketEntryOpen(true, { focus: true });
          return;
        }
        if (action === 'note') {
          addNote();
          return;
        }
        if (action === 'website') {
          addWebsitePreview();
          return;
        }
        if (action === 'link') {
          setActiveTool('link');
          setFeedback('Link mode enabled. Drag from a connector handle to another one.');
          return;
        }
        if (action === 'zoomIn') {
          setZoom(uiState.zoom + 0.1);
          return;
        }
        if (action === 'zoomOut') {
          setZoom(uiState.zoom - 0.1);
          return;
        }
        if (action === 'deleteConnector') {
          deleteSelectedConnector();
          return;
        }
        if (action === 'reset') {
          clearCanvas();
          return;
        }
      });
    }

    if (ticketAddButton instanceof HTMLElement) {
      ticketAddButton.addEventListener('click', requestAddTicket);
    }
    if (ticketEntryPanel instanceof HTMLFormElement) {
      ticketEntryPanel.addEventListener('submit', event => {
        event.preventDefault();
        requestAddTicket();
      });
    }
    if (ticketEntryCloseButton instanceof HTMLElement) {
      ticketEntryCloseButton.addEventListener('click', () => {
        setTicketEntryOpen(false);
        setFeedback('Ticket add cancelled.');
      });
    }
    if (ticketInput instanceof HTMLInputElement) {
      ticketInput.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setTicketEntryOpen(false);
          setFeedback('Ticket add cancelled.');
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          requestAddTicket();
        }
      });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object' || message.type !== 'addTicketResult') {
        return;
      }
      if (!message.ok) {
        setFeedback(message.error || 'Unable to add ticket.', true);
        return;
      }
      if (!message.node || typeof message.node !== 'object') {
        setFeedback('Ticket payload was invalid.', true);
        return;
      }

      state.nodes.push(message.node);
      uiState.selectedNodeId = message.node.id;
      uiState.selectedConnectorId = undefined;
      if (ticketInput instanceof HTMLInputElement) {
        ticketInput.value = '';
      }
      setTicketEntryOpen(false);
      renderNodes();
      persistCanvasState();
      setFeedback('Ticket ' + (message.node.issueKey || 'node') + ' added.');
    });

    canvasToolbarHandle?.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !(canvasToolbar instanceof HTMLElement) || !(canvasSurface instanceof HTMLElement)) {
        return;
      }
      const toolbarRect = canvasToolbar.getBoundingClientRect();
      uiState.toolbarDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - toolbarRect.left,
        offsetY: event.clientY - toolbarRect.top
      };
      canvasToolbarHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    window.addEventListener('pointermove', event => {
      if (!uiState.toolbarDrag || !(canvasSurface instanceof HTMLElement)) {
        return;
      }
      if (event.pointerId !== uiState.toolbarDrag.pointerId) {
        return;
      }
      const surfaceRect = canvasSurface.getBoundingClientRect();
      uiState.toolbarPosition = {
        x: canvasSurface.scrollLeft + event.clientX - surfaceRect.left - uiState.toolbarDrag.offsetX,
        y: canvasSurface.scrollTop + event.clientY - surfaceRect.top - uiState.toolbarDrag.offsetY
      };
      syncFloatingLayout();
    });

    window.addEventListener('pointerup', event => {
      if (!uiState.toolbarDrag || event.pointerId !== uiState.toolbarDrag.pointerId) {
        return;
      }
      uiState.toolbarDrag = undefined;
      schedulePersistCanvasState();
    });

    canvasSurface.addEventListener('scroll', syncFloatingLayout);
    window.addEventListener('resize', syncFloatingLayout);

    if (canvasSurface instanceof HTMLElement) {
      canvasSurface.addEventListener('dragover', event => {
        const types = event.dataTransfer?.types ?? [];
        const hasIssueData = types.includes('application/x-ticket-manager-issue') || types.includes('text/plain');
        if (!hasIssueData) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      });

      canvasSurface.addEventListener('drop', event => {
        const issueKey = (event.dataTransfer?.getData('application/x-ticket-manager-issue') || event.dataTransfer?.getData('text/plain') || '').trim();
        if (!issueKey || !(canvasSurface instanceof HTMLElement)) {
          return;
        }
        event.preventDefault();
        const surfaceRect = canvasSurface.getBoundingClientRect();
        requestAddTicketFromDrop(issueKey, {
          x: clientDistanceToCanvas(canvasSurface.scrollLeft + event.clientX - surfaceRect.left),
          y: clientDistanceToCanvas(canvasSurface.scrollTop + event.clientY - surfaceRect.top)
        });
      });
    }

    canvasSurface.addEventListener('mousedown', event => {
      if (event.target === canvasSurface || event.target === nodesLayer || event.target === connectorsLayer) {
        uiState.selectedNodeId = undefined;
        uiState.selectedConnectorId = undefined;
        renderNodes();
      }
    });

    syncToolbarState();
    syncFloatingLayout();
    setTicketEntryOpen(false);
    renderNodes();
    updateDeleteConnectorState();

    setFeedback(
      state.nodes.length === 0
        ? 'Use ticket, note, or website tools to create components.'
        : state.nodes.length + ' component(s) loaded.'
    );
  </script>
</body>
</html>`;
  }
}
