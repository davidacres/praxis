import * as vscode from 'vscode';
import { DEFAULT_MAX_AGE_WEEKS } from '../board/boardIssueFilters';
import { defaultStatusDotHex, sanitizeStatusColors } from '../board/statusColors';
import type { Board, BoardColumnPreferences, BoardDetails } from '../types';
import type { BoardColumnStore } from '../state/boardColumnStore';
import { normalizeOptionalHexColor } from '../ui/hexColor';
import { getDefaultStatusColumnOrder } from './boardColumnLayout';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type BoardNameUpdater = (boardId: string, name: string) => Promise<void>;
type BoardQueryUpdater = (boardId: string, jql: string) => Promise<void>;
type BoardSettingsUpdater = (
  boardId: string,
  input: { name: string; jql?: string }
) => Promise<void>;

function normalizeStatuses(statuses: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    const trimmed = status.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildWorkflowRows(
  prefs: BoardColumnPreferences,
  defaultWorkflow: string[]
): string[] {
  return prefs.workflowStatuses.length ? [...prefs.workflowStatuses] : [...defaultWorkflow];
}

function buildColumnRows(
  prefs: BoardColumnPreferences,
  workflowRows: string[]
): Array<{ status: string; checked: boolean }> {
  if (!prefs.orderedStatuses.length) {
    return workflowRows.map(status => ({ status, checked: true }));
  }

  const seen = new Set(prefs.orderedStatuses);
  const rows = prefs.orderedStatuses
    .filter(status => workflowRows.includes(status))
    .map(status => ({ status, checked: true }));
  for (const status of workflowRows) {
    if (!seen.has(status)) {
      rows.push({ status, checked: false });
    }
  }
  return rows;
}

export class BoardColumnConfigPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private boardNameUpdater?: BoardNameUpdater;
  private boardQueryUpdater?: BoardQueryUpdater;
  private boardSettingsUpdater?: BoardSettingsUpdater;

  public constructor(private readonly columnStore: BoardColumnStore) {}

  public setBoardNameUpdater(updater: BoardNameUpdater): void {
    this.boardNameUpdater = updater;
  }

  public setBoardQueryUpdater(updater: BoardQueryUpdater): void {
    this.boardQueryUpdater = updater;
  }

  public setBoardSettingsUpdater(updater: BoardSettingsUpdater): void {
    this.boardSettingsUpdater = updater;
  }

  public async open(board: Board, details: BoardDetails): Promise<void> {
    this.ensurePanel();
    const defaultWorkflow = getDefaultStatusColumnOrder(details);
    await this.columnStore.normalizeLegacyPreferences(board.id, defaultWorkflow);
    const prefs = this.columnStore.getPreferences(board.id);
    const workflowRows = buildWorkflowRows(prefs, defaultWorkflow);
    const columnRows = buildColumnRows(prefs, workflowRows);

    const defaultStatusHex: Record<string, string> = {};
    const statusColorsState: Record<string, string> = {};
    for (const s of workflowRows) {
      const def = defaultStatusDotHex(s);
      defaultStatusHex[s] = def;
      statusColorsState[s] = prefs.statusColors?.[s] ?? def;
    }

    const payload = {
      boardId: board.id,
      boardName: board.name,
      boardType: board.type,
      boardQuery: isRecord(board.raw) && typeof board.raw.jql === 'string' ? board.raw.jql : '',
      defaultWorkflow,
      useCustomWorkflow: prefs.workflowStatuses.length > 0,
      useCustomColumns: prefs.orderedStatuses.length > 0,
      workflowRows,
      columnRows,
      projectPillColor: prefs.projectPillColor ?? '',
      swimLaneGroupBy: prefs.swimLaneGroupBy ?? 'none',
      issueFilterAssignee: prefs.issueFilterAssignee ?? '',
      issueFilterEpicKey: prefs.issueFilterEpicKey ?? '',
      issueFilterStatuses: prefs.issueFilterStatuses ?? [],
      maxAgeWeeks: prefs.maxAgeWeeks ?? DEFAULT_MAX_AGE_WEEKS,
      defaultStatusHex,
      statusColorsState
    };

    this.panel!.title = `Board Settings: ${board.name}`;
    this.panel!.webview.html = this.getHtml(payload);
    this.panel!.reveal(vscode.ViewColumn.Active, false);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.boardColumnConfig',
      'Board settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = typeof message.type === 'string' ? message.type : '';

    if (type === 'save') {
      const boardId = typeof message.boardId === 'string' ? message.boardId : '';
      const boardName = typeof message.boardName === 'string' ? message.boardName.trim() : '';
      const originalBoardName =
        typeof message.originalBoardName === 'string' ? message.originalBoardName.trim() : '';
      const boardQuery = typeof message.boardQuery === 'string' ? message.boardQuery.trim() : '';
      const originalBoardQuery =
        typeof message.originalBoardQuery === 'string' ? message.originalBoardQuery.trim() : '';
      const boardType = typeof message.boardType === 'string' ? message.boardType : '';
      const useCustomWorkflow = Boolean(message.useCustomWorkflow);
      const useCustomColumns = Boolean(message.useCustomColumns);
      const defaultWorkflow = Array.isArray(message.defaultWorkflow)
        ? normalizeStatuses(message.defaultWorkflow.filter((s): s is string => typeof s === 'string'))
        : [];
      const workflowStatuses = Array.isArray(message.workflowStatuses)
        ? normalizeStatuses(message.workflowStatuses.filter((s): s is string => typeof s === 'string'))
        : [];
      const orderedStatuses = Array.isArray(message.orderedStatuses)
        ? normalizeStatuses(message.orderedStatuses.filter((s): s is string => typeof s === 'string'))
        : [];
      const rawPill =
        typeof message.projectPillColor === 'string' ? message.projectPillColor.trim() : '';
      if (rawPill && !normalizeOptionalHexColor(rawPill)) {
        void vscode.window.showWarningMessage(
          'Project pill color must be a valid hex value (#rgb or #rrggbb) or empty.'
        );
        return;
      }
      const projectPillColor = normalizeOptionalHexColor(rawPill);

      const swimLaneRaw = typeof message.swimLaneGroupBy === 'string' ? message.swimLaneGroupBy : 'none';
      const swimLaneGroupBy =
        swimLaneRaw === 'assignee' || swimLaneRaw === 'epic' ? swimLaneRaw : 'none';

      const issueFilterAssignee =
        typeof message.issueFilterAssignee === 'string' ? message.issueFilterAssignee.trim() : '';
      const issueFilterEpicKey =
        typeof message.issueFilterEpicKey === 'string' ? message.issueFilterEpicKey.trim() : '';
      const issueFilterStatuses = Array.isArray(message.issueFilterStatuses)
        ? normalizeStatuses(message.issueFilterStatuses.filter((s): s is string => typeof s === 'string'))
        : [];

      const sanitizedColors = sanitizeStatusColors(message.statusColors);
      let statusColorsOut: Record<string, string> | undefined;
      if (sanitizedColors) {
        const trimmed: Record<string, string> = {};
        for (const [status, hex] of Object.entries(sanitizedColors)) {
          if (hex !== defaultStatusDotHex(status)) {
            trimmed[status] = hex;
          }
        }
        if (Object.keys(trimmed).length > 0) {
          statusColorsOut = trimmed;
        }
      }

      if (!boardId) {
        return;
      }

      if (!boardName) {
        void vscode.window.showWarningMessage('Board name is required.');
        return;
      }

      if (
        this.boardSettingsUpdater &&
        (boardName !== originalBoardName || (boardType === 'jql' && boardQuery !== originalBoardQuery))
      ) {
        try {
          await this.boardSettingsUpdater(boardId, {
            name: boardName,
            jql: boardType === 'jql' ? boardQuery : undefined
          });
        } catch (error) {
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
      }

      const nextPrefs: BoardColumnPreferences = {
        workflowStatuses:
          useCustomWorkflow && !arraysEqual(workflowStatuses, defaultWorkflow) ? workflowStatuses : [],
        orderedStatuses: useCustomColumns ? orderedStatuses : []
      };
      if (projectPillColor) {
        nextPrefs.projectPillColor = projectPillColor;
      }
      if (swimLaneGroupBy !== 'none') {
        nextPrefs.swimLaneGroupBy = swimLaneGroupBy;
      }
      if (issueFilterAssignee) {
        nextPrefs.issueFilterAssignee = issueFilterAssignee;
      }
      if (issueFilterEpicKey) {
        nextPrefs.issueFilterEpicKey = issueFilterEpicKey;
      }
      if (issueFilterStatuses.length > 0) {
        nextPrefs.issueFilterStatuses = issueFilterStatuses;
      }
      const maxAgeWeeks =
        typeof message.maxAgeWeeks === 'number' && Number.isFinite(message.maxAgeWeeks)
          ? Math.max(0, Math.floor(message.maxAgeWeeks))
          : DEFAULT_MAX_AGE_WEEKS;
      if (maxAgeWeeks !== DEFAULT_MAX_AGE_WEEKS) {
        nextPrefs.maxAgeWeeks = maxAgeWeeks;
      }
      if (statusColorsOut) {
        nextPrefs.statusColors = statusColorsOut;
      }

      const hasExtra =
        Boolean(nextPrefs.projectPillColor) ||
        (nextPrefs.swimLaneGroupBy && nextPrefs.swimLaneGroupBy !== 'none') ||
        Boolean(nextPrefs.issueFilterAssignee) ||
        Boolean(nextPrefs.issueFilterEpicKey) ||
        (nextPrefs.issueFilterStatuses && nextPrefs.issueFilterStatuses.length > 0) ||
        nextPrefs.maxAgeWeeks !== undefined ||
        Boolean(nextPrefs.statusColors && Object.keys(nextPrefs.statusColors).length > 0);

      if (
        nextPrefs.workflowStatuses.length === 0 &&
        nextPrefs.orderedStatuses.length === 0 &&
        !hasExtra
      ) {
        await this.columnStore.clearPreferences(boardId);
      } else {
        await this.columnStore.setPreferences(boardId, nextPrefs);
      }

      void vscode.window.showInformationMessage('Board settings saved.');
      this.panel?.dispose();
      return;
    }

    if (type === 'cancel') {
      this.panel?.dispose();
    }
  }

  private getHtml(payload: {
    boardId: string;
    boardName: string;
    boardType: string;
    boardQuery: string;
    defaultWorkflow: string[];
    useCustomWorkflow: boolean;
    useCustomColumns: boolean;
    workflowRows: string[];
    columnRows: Array<{ status: string; checked: boolean }>;
    projectPillColor: string;
    swimLaneGroupBy: string;
    issueFilterAssignee: string;
    issueFilterEpicKey: string;
    issueFilterStatuses: string[];
    maxAgeWeeks: number;
    defaultStatusHex: Record<string, string>;
    statusColorsState: Record<string, string>;
  }): string {
    const nonce = createNonce();
    const json = JSON.stringify(payload);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Board settings</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 20px 24px 32px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      max-width: 760px;
    }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      line-height: 1.45;
    }
    .section {
      margin-top: 20px;
    }
    .section h2 {
      margin: 0 0 6px;
      font-size: 14px;
    }
    .mode {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .mode input { cursor: pointer; }
    .list {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 12px;
      opacity: 1;
    }
    .list.disabled { opacity: 0.45; pointer-events: none; }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      cursor: grab;
    }
    .row:last-child { border-bottom: none; }
    .row.dragging { opacity: 0.5; }
    .row .drag-hint {
      color: var(--vscode-descriptionForeground);
      cursor: grab;
      user-select: none;
    }
    .row input[type="checkbox"] { cursor: pointer; }
    .row .name {
      flex: 1;
      font-size: 13px;
      min-width: 0;
    }
    .row .name-input {
      flex: 1;
      box-sizing: border-box;
      min-width: 0;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    .row .remove-btn {
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-button-border, transparent));
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .sub-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 24px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    }
    button:hover { filter: brightness(1.06); }
    .helper {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .color-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .color-row input[type="color"] {
      width: 40px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      cursor: pointer;
      background: var(--vscode-input-background);
    }
    .color-row input[type="text"] {
      box-sizing: border-box;
      width: 120px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    .field-label {
      display: block;
      margin-top: 10px;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .field-input,
    .field-select {
      box-sizing: border-box;
      width: 100%;
      max-width: 420px;
      padding: 6px 8px;
      margin-bottom: 4px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    .filter-status-row,
    .status-color-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-color-row .status-name {
      flex: 1;
      min-width: 0;
      font-size: 13px;
    }
    .status-color-row input[type="color"] {
      width: 40px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      cursor: pointer;
    }
  </style>
</head>
  <body>
  <label class="field-label" for="boardName">Board name</label>
  <input type="text" id="boardName" class="field-input" value="${escapeHtml(payload.boardName)}" />
  ${payload.boardType === 'jql' ? `
  <label class="field-label" for="boardQuery">Board JQL</label>
  <input type="text" id="boardQuery" class="field-input" value="${escapeHtml(payload.boardQuery)}" placeholder="project = KAMAI AND issuetype in (Story, Task)" />
  <p class="helper">This JQL defines which issues appear on the board.</p>` : ''}
  <h1>${escapeHtml(payload.boardName)}</h1>
  <p>Set this board's workflow statuses and the columns you want to see. The workflow order becomes the default board layout; column customization can then hide or reorder those statuses locally.</p>

  <section class="section">
    <h2>Board list</h2>
    <p class="helper">Color for the project or location pill on this board&rsquo;s row in the Boards sidebar (hex, e.g. #22c55e). Leave blank to use the default theme pill.</p>
    <div class="color-row">
      <input type="color" id="projectPillColorPicker" value="${escapeHtml(
        /^#[0-9a-fA-F]{6}$/.test(payload.projectPillColor) ? payload.projectPillColor : '#808080'
      )}" title="Pick color" />
      <input type="text" id="projectPillColorHex" placeholder="#aabbcc" value="${escapeHtml(
        payload.projectPillColor
      )}" spellcheck="false" />
      <button type="button" class="secondary" id="clearProjectPillColorBtn">Clear</button>
    </div>
  </section>

  <section class="section">
    <h2>Swim lanes</h2>
    <p class="helper">Group the board into horizontal bands. Each band shows the same status columns for a subset of tickets.</p>
    <select id="swimLaneSelect" class="field-select">
      <option value="none" ${payload.swimLaneGroupBy === 'none' ? 'selected' : ''}>None</option>
      <option value="assignee" ${payload.swimLaneGroupBy === 'assignee' ? 'selected' : ''}>By assignee</option>
      <option value="epic" ${payload.swimLaneGroupBy === 'epic' ? 'selected' : ''}>By epic (parent)</option>
    </select>
  </section>

  <section class="section">
    <h2>Board filters</h2>
    <p class="helper">Narrow which tickets load into this board view. For statuses, leave every box checked to allow all workflow columns.</p>
    <label class="field-label" for="issueFilterAssignee">Assignee contains</label>
    <input type="text" id="issueFilterAssignee" class="field-input" value="${escapeHtml(
      payload.issueFilterAssignee
    )}" placeholder="Substring of assignee name" />
    <label class="field-label" for="issueFilterEpicKey">Epic key or title contains</label>
    <input type="text" id="issueFilterEpicKey" class="field-input" value="${escapeHtml(
      payload.issueFilterEpicKey
    )}" placeholder="e.g. APP-100 or summary text" />
    <label class="field-label" for="maxAgeWeeks">Hide tickets not updated within (weeks)</label>
    <input type="number" id="maxAgeWeeks" class="field-input" style="max-width:120px;" min="0" step="1" value="${payload.maxAgeWeeks}" placeholder="0 = show all" />
    <span class="helper">0 = show all tickets regardless of age</span>
    <p class="helper" style="margin-top:12px;">Include tickets in these statuses</p>
    <div id="filterStatusList" class="list"></div>
  </section>

  <section class="section">
    <h2>Status colors</h2>
    <p class="helper">Column header dot color per status. Values start from the built-in defaults; override any hex as needed.</p>
    <div id="statusColorList" class="list"></div>
  </section>

  <section class="section">
    <h2>Workflow</h2>
    <p class="helper">Use the board's current statuses as the default. Turn customization on to add, remove, rename, or reorder workflow steps.</p>
    <label class="mode">
      <input type="checkbox" id="useCustomWorkflow" ${payload.useCustomWorkflow ? 'checked' : ''} />
      <span>Customize workflow</span>
    </label>
    <div id="workflowList" class="list${payload.useCustomWorkflow ? '' : ' disabled'}"></div>
    <div class="sub-actions">
      <button type="button" class="secondary" id="addWorkflowStatusBtn">Add Status</button>
    </div>
  </section>

  <section class="section">
    <h2>Columns</h2>
    <p class="helper">Choose which workflow statuses show as board columns and their order. When customization is off, every workflow status is shown.</p>
    <label class="mode">
      <input type="checkbox" id="useCustomColumns" ${payload.useCustomColumns ? 'checked' : ''} />
      <span>Customize columns</span>
    </label>
    <div id="columnList" class="list${payload.useCustomColumns ? '' : ' disabled'}"></div>
  </section>

  <div class="actions">
    <button type="button" id="saveBtn">Save</button>
    <button type="button" class="secondary" id="resetBtn">Reset to current default</button>
    <button type="button" class="secondary" id="cancelBtn">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const initial = ${json};
    const workflowListEl = document.getElementById('workflowList');
    const columnListEl = document.getElementById('columnList');
    const statusColorListEl = document.getElementById('statusColorList');
    const filterStatusListEl = document.getElementById('filterStatusList');
    const useCustomWorkflowEl = document.getElementById('useCustomWorkflow');
    const useCustomColumnsEl = document.getElementById('useCustomColumns');
    const projectPillHexEl = document.getElementById('projectPillColorHex');
    const projectPillPickerEl = document.getElementById('projectPillColorPicker');

    let workflowRows = initial.workflowRows.slice();
    let columnRows = initial.columnRows.map(row => ({ status: row.status, checked: row.checked }));
    let statusColorsMap = { ...initial.statusColorsState };
    let filterStatusChecked = {};

    function defaultStatusDotHexFallback(status) {
      const n = String(status).trim().toLowerCase();
      const map = {
        backlog: '#2ea043',
        'to do': '#1f6feb',
        todo: '#1f6feb',
        'in progress': '#d18616',
        blocked: '#d1242f',
        done: '#2ea043'
      };
      return map[n] || '#8b949e';
    }

    function initFilterChecksFromSaved(saved) {
      const keys = normalizeStatuses(workflowRows);
      const savedSet = new Set(saved || []);
      filterStatusChecked = {};
      for (const k of keys) {
        filterStatusChecked[k] = !saved || saved.length === 0 ? true : savedSet.has(k);
      }
    }

    function syncMapsFromWorkflow() {
      const keys = normalizeStatuses(workflowRows);
      const nextColors = {};
      for (const k of keys) {
        nextColors[k] =
          statusColorsMap[k] ||
          initial.defaultStatusHex[k] ||
          defaultStatusDotHexFallback(k);
      }
      statusColorsMap = nextColors;
      const prev = { ...filterStatusChecked };
      const nextF = {};
      for (const k of keys) {
        nextF[k] = Object.prototype.hasOwnProperty.call(prev, k) ? prev[k] : true;
      }
      filterStatusChecked = nextF;
    }

    function renderFilterStatusList() {
      filterStatusListEl.innerHTML = '';
      const keys = normalizeStatuses(workflowRows);
      for (const k of keys) {
        const row = document.createElement('div');
        row.className = 'row filter-status-row';
        const id = 'fs-' + k.replace(/[^a-zA-Z0-9]+/g, '_');
        row.innerHTML =
          '<input type="checkbox" id="' +
          id +
          '" data-status="' +
          escapeAttr(k) +
          '" ' +
          (filterStatusChecked[k] ? 'checked' : '') +
          ' /><label for="' +
          id +
          '" class="name">' +
          escapeHtml(k) +
          '</label>';
        filterStatusListEl.appendChild(row);
      }
      for (const cb of filterStatusListEl.querySelectorAll('input[type="checkbox"]')) {
        cb.addEventListener('change', () => {
          const st = cb.dataset.status;
          if (st) {
            filterStatusChecked[st] = cb.checked;
          }
        });
      }
    }

    function renderStatusColorList() {
      statusColorListEl.innerHTML = '';
      const keys = normalizeStatuses(workflowRows);
      for (const k of keys) {
        const hex =
          statusColorsMap[k] ||
          initial.defaultStatusHex[k] ||
          defaultStatusDotHexFallback(k);
        const safeHex = /^#[0-9a-fA-F]{6}$/i.test(hex) ? hex : '#888888';
        const row = document.createElement('div');
        row.className = 'row status-color-row';
        const id = 'sc-' + k.replace(/[^a-zA-Z0-9]+/g, '_');
        row.innerHTML =
          '<span class="status-name">' +
          escapeHtml(k) +
          '</span>' +
          '<input type="color" class="sc-picker" data-status="' +
          escapeAttr(k) +
          '" value="' +
          escapeAttr(safeHex) +
          '" />' +
          '<input type="text" class="name-input sc-hex" data-status="' +
          escapeAttr(k) +
          '" value="' +
          escapeAttr(hex) +
          '" />';
        statusColorListEl.appendChild(row);
      }
      for (const p of statusColorListEl.querySelectorAll('.sc-picker')) {
        p.addEventListener('input', () => {
          const st = p.dataset.status;
          if (st) {
            statusColorsMap[st] = p.value;
            const hexInput = statusColorListEl.querySelector('.sc-hex[data-status="' + escapeAttr(st) + '"]');
            if (hexInput) {
              hexInput.value = p.value;
            }
          }
        });
      }
      for (const inp of statusColorListEl.querySelectorAll('.sc-hex')) {
        inp.addEventListener('input', () => {
          const st = inp.dataset.status;
          const v = inp.value.trim();
          if (st && /^#[0-9a-fA-F]{6}$/i.test(v)) {
            statusColorsMap[st] = v;
            const picker = statusColorListEl.querySelector('.sc-picker[data-status="' + escapeAttr(st) + '"]');
            if (picker) {
              picker.value = v;
            }
          }
        });
      }
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function escapeAttr(s) {
      return String(s).replace(/"/g, '&quot;');
    }

    function normalizeStatuses(values) {
      const unique = [];
      const seen = new Set();
      for (const value of values) {
        const trimmed = String(value || '').trim();
        if (!trimmed || seen.has(trimmed)) {
          continue;
        }
        seen.add(trimmed);
        unique.push(trimmed);
      }
      return unique;
    }

    function syncDisabledState() {
      workflowListEl.classList.toggle('disabled', !useCustomWorkflowEl.checked);
      columnListEl.classList.toggle('disabled', !useCustomColumnsEl.checked);
    }

    function reconcileColumns() {
      const checkedByStatus = new Map(columnRows.map(row => [row.status, row.checked]));
      columnRows = workflowRows.map(status => ({
        status,
        checked: checkedByStatus.has(status) ? Boolean(checkedByStatus.get(status)) : true
      }));
    }

    function renderWorkflowList() {
      workflowListEl.innerHTML = '';
      for (let i = 0; i < workflowRows.length; i++) {
        const row = document.createElement('div');
        row.className = 'row';
        row.draggable = true;
        row.dataset.index = String(i);
        row.innerHTML =
          '<span class="drag-hint" title="Drag to reorder">⠿</span>' +
          '<input type="text" class="name-input" value="' + escapeAttr(workflowRows[i]) + '" data-index="' + i + '" />' +
          '<button type="button" class="remove-btn" data-index="' + i + '">Remove</button>';
        workflowListEl.appendChild(row);
      }

      for (const row of workflowListEl.querySelectorAll('.row')) {
        row.addEventListener('dragstart', e => {
          row.classList.add('dragging');
          e.dataTransfer.setData('text/plain', row.dataset.index);
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', e => {
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          const to = parseInt(row.dataset.index, 10);
          if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
          const next = workflowRows.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          workflowRows = next;
          reconcileColumns();
          renderAll();
        });
      }

      for (const input of workflowListEl.querySelectorAll('.name-input')) {
        input.addEventListener('input', () => {
          const index = parseInt(input.dataset.index, 10);
          if (Number.isNaN(index)) {
            return;
          }
          workflowRows[index] = input.value;
          reconcileColumns();
          renderColumnList();
        });
      }

      for (const button of workflowListEl.querySelectorAll('.remove-btn')) {
        button.addEventListener('click', () => {
          const index = parseInt(button.dataset.index, 10);
          if (Number.isNaN(index)) {
            return;
          }
          workflowRows.splice(index, 1);
          reconcileColumns();
          renderAll();
        });
      }
    }

    function renderColumnList() {
      columnListEl.innerHTML = '';
      for (let i = 0; i < columnRows.length; i++) {
        const row = document.createElement('div');
        row.className = 'row';
        row.draggable = true;
        row.dataset.index = String(i);
        const current = columnRows[i];
        row.innerHTML =
          '<span class="drag-hint" title="Drag to reorder">⠿</span>' +
          '<input type="checkbox" class="vis" ' + (current.checked ? 'checked' : '') + ' data-status="' + escapeAttr(current.status) + '" />' +
          '<span class="name">' + escapeHtml(current.status) + '</span>';
        columnListEl.appendChild(row);
      }

      for (const row of columnListEl.querySelectorAll('.row')) {
        row.addEventListener('dragstart', e => {
          row.classList.add('dragging');
          e.dataTransfer.setData('text/plain', row.dataset.index);
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', e => {
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          const to = parseInt(row.dataset.index, 10);
          if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
          const next = columnRows.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          columnRows = next;
          renderColumnList();
        });
      }

      for (const cb of columnListEl.querySelectorAll('.vis')) {
        cb.addEventListener('change', () => {
          const status = cb.dataset.status;
          const entry = columnRows.find(row => row.status === status);
          if (entry) {
            entry.checked = cb.checked;
          }
        });
      }
    }

    function renderAll() {
      syncMapsFromWorkflow();
      renderWorkflowList();
      renderColumnList();
      renderFilterStatusList();
      renderStatusColorList();
      syncDisabledState();
    }

    function syncPickerFromHex() {
      const raw = String(projectPillHexEl.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
        projectPillPickerEl.value = raw;
      }
    }

    projectPillHexEl.addEventListener('input', syncPickerFromHex);
    projectPillPickerEl.addEventListener('input', () => {
      projectPillHexEl.value = projectPillPickerEl.value;
    });
    document.getElementById('clearProjectPillColorBtn').addEventListener('click', () => {
      projectPillHexEl.value = '';
      projectPillPickerEl.value = '#808080';
    });

    useCustomWorkflowEl.addEventListener('change', syncDisabledState);
    useCustomColumnsEl.addEventListener('change', syncDisabledState);

    document.getElementById('addWorkflowStatusBtn').addEventListener('click', () => {
      workflowRows.push('');
      reconcileColumns();
      renderAll();
      const inputs = workflowListEl.querySelectorAll('.name-input');
      const lastInput = inputs[inputs.length - 1];
      lastInput?.focus();
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
      useCustomWorkflowEl.checked = false;
      useCustomColumnsEl.checked = false;
      document.getElementById('boardName').value = initial.boardName;
      if (document.getElementById('boardQuery')) {
        document.getElementById('boardQuery').value = initial.boardQuery || '';
      }
      workflowRows = initial.defaultWorkflow.slice();
      columnRows = workflowRows.map(status => ({ status, checked: true }));
      projectPillHexEl.value = '';
      projectPillPickerEl.value = '#808080';
      document.getElementById('swimLaneSelect').value = 'none';
      document.getElementById('issueFilterAssignee').value = '';
      document.getElementById('issueFilterEpicKey').value = '';
      statusColorsMap = {};
      for (const s of workflowRows) {
        statusColorsMap[s] =
          initial.defaultStatusHex[s] || defaultStatusDotHexFallback(s);
      }
      initFilterChecksFromSaved([]);
      renderAll();
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'cancel' });
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
      const boardName = String(document.getElementById('boardName').value || '').trim();
      const boardQueryInput = document.getElementById('boardQuery');
      const boardQuery = boardQueryInput ? String(boardQueryInput.value || '').trim() : '';
      const workflowStatuses = normalizeStatuses(workflowRows);
      if (useCustomWorkflowEl.checked && workflowStatuses.length === 0) {
        alert('Add at least one workflow status, or turn off workflow customization.');
        return;
      }

      const orderedStatuses = columnRows
        .filter(row => row.checked)
        .map(row => row.status)
        .filter(status => workflowStatuses.includes(status) || initial.defaultWorkflow.includes(status));
      if (useCustomColumnsEl.checked && orderedStatuses.length === 0) {
        alert('Select at least one status column, or turn off column customization.');
        return;
      }

      const rawPill = String(projectPillHexEl.value || '').trim();
      if (rawPill && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(rawPill)) {
        alert('Project pill color must be empty or a hex value like #2a5 or #22aa55.');
        return;
      }

      const wfKeys = normalizeStatuses(workflowRows);
      const allStatusesChecked = wfKeys.length === 0 || wfKeys.every(k => filterStatusChecked[k]);
      const issueFilterStatusesPayload = allStatusesChecked ? [] : wfKeys.filter(k => filterStatusChecked[k]);

      vscodeApi.postMessage({
        type: 'save',
        boardId: initial.boardId,
        boardName,
        originalBoardName: initial.boardName,
        boardType: initial.boardType,
        boardQuery,
        originalBoardQuery: initial.boardQuery,
        defaultWorkflow: initial.defaultWorkflow,
        useCustomWorkflow: useCustomWorkflowEl.checked,
        useCustomColumns: useCustomColumnsEl.checked,
        workflowStatuses: useCustomWorkflowEl.checked ? workflowStatuses : [],
        orderedStatuses: useCustomColumnsEl.checked ? orderedStatuses : [],
        projectPillColor: String(projectPillHexEl.value || '').trim(),
        swimLaneGroupBy: document.getElementById('swimLaneSelect').value,
        issueFilterAssignee: document.getElementById('issueFilterAssignee').value.trim(),
        issueFilterEpicKey: document.getElementById('issueFilterEpicKey').value.trim(),
        maxAgeWeeks: parseInt(document.getElementById('maxAgeWeeks').value, 10) || 0,
        issueFilterStatuses: issueFilterStatusesPayload,
        statusColors: statusColorsMap
      });
    });

    initFilterChecksFromSaved(initial.issueFilterStatuses);
    renderAll();
  </script>
</body>
</html>`;
  }
}
