import * as vscode from 'vscode';
import type { BoardColumnPreferences, JiraBoard, JiraBoardDetails } from '../types';
import type { BoardColumnStore } from '../state/boardColumnStore';
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

function buildRowModels(
  prefs: BoardColumnPreferences,
  defaultOrder: string[]
): Array<{ status: string; checked: boolean }> {
  if (!prefs.orderedStatuses.length) {
    return defaultOrder.map(status => ({ status, checked: true }));
  }

  const seen = new Set(prefs.orderedStatuses);
  const rows = prefs.orderedStatuses.map(status => ({ status, checked: true }));
  for (const status of defaultOrder) {
    if (!seen.has(status)) {
      rows.push({ status, checked: false });
    }
  }
  return rows;
}

export class BoardColumnConfigPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  public constructor(private readonly columnStore: BoardColumnStore) {}

  public async open(board: JiraBoard, details: JiraBoardDetails): Promise<void> {
    this.ensurePanel();
    const prefs = this.columnStore.getPreferences(board.id);
    const defaultOrder = getDefaultStatusColumnOrder(details);
    const useCustom = prefs.orderedStatuses.length > 0;
    const rowModels = buildRowModels(prefs, defaultOrder);

    const payload = {
      boardId: board.id,
      boardName: board.name,
      defaultOrder,
      useCustom,
      rowModels
    };

    this.panel!.title = `Columns: ${board.name}`;
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
      'jiraMini.boardColumnConfig',
      'Board columns',
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
      const useCustom = Boolean(message.useCustom);
      const ordered = Array.isArray(message.orderedStatuses)
        ? message.orderedStatuses.filter((s): s is string => typeof s === 'string')
        : [];

      if (!boardId) {
        return;
      }

      if (!useCustom) {
        await this.columnStore.clearPreferences(boardId);
      } else {
        await this.columnStore.setPreferences(boardId, { orderedStatuses: ordered });
      }

      void vscode.window.showInformationMessage(
        useCustom ? 'Board column layout saved.' : 'Board columns reset to default (all statuses).'
      );
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
    defaultOrder: string[];
    useCustom: boolean;
    rowModels: Array<{ status: string; checked: boolean }>;
  }): string {
    const nonce = createNonce();
    const json = JSON.stringify(payload);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Board columns</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 20px 24px 32px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      max-width: 560px;
    }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 16px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.45; }
    .mode {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .mode input { cursor: pointer; }
    .list {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 16px;
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
    .row .drag-hint { color: var(--vscode-descriptionForeground); cursor: grab; user-select: none; }
    .row input[type="checkbox"] { cursor: pointer; }
    .row .name { flex: 1; font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
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
  </style>
</head>
<body>
  <h1>${escapeHtml(payload.boardName)}</h1>
  <p>Choose which status columns appear on this board and their order. When customization is off, every status is shown in the default workflow order.</p>

  <label class="mode">
    <input type="checkbox" id="useCustom" ${payload.useCustom ? 'checked' : ''} />
    <span>Customize columns</span>
  </label>

  <div id="list" class="list${payload.useCustom ? '' : ' disabled'}"></div>

  <div class="actions">
    <button type="button" id="saveBtn">Save</button>
    <button type="button" class="secondary" id="resetBtn">Reset to default</button>
    <button type="button" class="secondary" id="cancelBtn">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const initial = ${json};

    const listEl = document.getElementById('list');
    const useCustomEl = document.getElementById('useCustom');

    let rows = initial.rowModels.map(r => ({ status: r.status, checked: r.checked }));

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

    function syncUseCustom() {
      const on = useCustomEl.checked;
      listEl.classList.toggle('disabled', !on);
    }

    function renderList() {
      listEl.innerHTML = '';
      for (let i = 0; i < rows.length; i++) {
        const row = document.createElement('div');
        row.className = 'row';
        row.draggable = true;
        row.dataset.index = String(i);
        const r = rows[i];
        row.innerHTML =
          '<span class="drag-hint" title="Drag to reorder">⠿</span>' +
          '<input type="checkbox" class="vis" ' + (r.checked ? 'checked' : '') + ' data-status="' + escapeAttr(r.status) + '" />' +
          '<span class="name">' + escapeHtml(r.status) + '</span>';
        listEl.appendChild(row);
      }

      for (const row of listEl.querySelectorAll('.row')) {
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
          const next = rows.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          rows = next;
          renderList();
        });
      }

      for (const cb of listEl.querySelectorAll('.vis')) {
        cb.addEventListener('change', () => {
          const status = cb.dataset.status;
          const entry = rows.find(r => r.status === status);
          if (entry) entry.checked = cb.checked;
        });
      }
    }

    useCustomEl.addEventListener('change', syncUseCustom);

    document.getElementById('resetBtn').addEventListener('click', () => {
      useCustomEl.checked = false;
      rows = initial.defaultOrder.map(s => ({ status: s, checked: true }));
      syncUseCustom();
      renderList();
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'cancel' });
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
      const useCustom = useCustomEl.checked;
      let ordered = [];
      if (useCustom) {
        for (const row of listEl.querySelectorAll('.row')) {
          const cb = row.querySelector('.vis');
          if (cb && cb.checked) {
            ordered.push(cb.dataset.status);
          }
        }
        if (ordered.length === 0) {
          alert('Select at least one status column, or turn off customization.');
          return;
        }
      }
      vscodeApi.postMessage({
        type: 'save',
        boardId: initial.boardId,
        useCustom,
        orderedStatuses: useCustom ? ordered : []
      });
    });

    renderList();
    syncUseCustom();
  </script>
</body>
</html>`;
  }
}
