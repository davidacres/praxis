import * as vscode from 'vscode';
import type { BoardColumnStore } from '../state/boardColumnStore';
import { BoardStore } from '../state/boardStore';
import type { BackendMode } from '../types';
import { buildMetaPillInlineStyle, parseHexRgb } from '../ui/hexColor';
import { boardListModeIconSvg, resolveBackendModeBoardIconColor } from './boardModeIcon';
import { BoardsTreeProvider } from './boardsTreeProvider';

import { renderIconButton } from './webviewToolbarIcons';

interface BoardsSidebarCallbacks {
  onSelectBoard: (boardId: string) => Promise<void>;
  onEditBoard: (boardId: string) => Promise<void>;
  onDeleteBoard: (boardId: string) => Promise<void>;
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

function renderPill(label: string, token: string, inlineStyle?: string): string {
  const styleAttr =
    inlineStyle && inlineStyle.length > 0
      ? ` style="${inlineStyle.replace(/"/g, '&quot;')}"`
      : '';
  return `<span class="pill pill--${token}"${styleAttr}>${escapeHtml(label)}</span>`;
}

function boardTypeToken(boardType: string | undefined): string {
  const normalized = boardType?.trim().toLowerCase();
  if (normalized === 'scrum' || normalized === 'kanban' || normalized === 'epic' || normalized === 'jql') {
    return normalized;
  }
  return 'board';
}

export class BoardsSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selectedBoardId?: string;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly boardStore: BoardStore,
    private readonly boardsProvider: BoardsTreeProvider,
    private readonly boardColumnStore: BoardColumnStore,
    private readonly getBackendMode: () => BackendMode,
    private readonly callbacks: BoardsSidebarCallbacks
  ) {
    this.disposables.push(
      this.boardsProvider.onDidChangeTreeData(() => {
        this.render();
      }),
      this.boardStore.onDidChange(() => {
        this.render();
      }),
      this.boardColumnStore.onDidChange(() => {
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
      default:
        return;
    }
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
      content =
        filters.searchText.trim().length > 0
          ? `<div class="message">No boards match "${escapeHtml(filters.searchText.trim())}".</div>`
          : filters.projectKeys.length > 0 || filters.types.length > 0
            ? '<div class="message">No boards match the current board filters.</div>'
            : '<div class="message">No boards are available.</div>';
    } else {
      const backendMode = this.getBackendMode();
      const modeIconColor = resolveBackendModeBoardIconColor(backendMode);
      const modeIconMarkup = boardListModeIconSvg(backendMode);
      content = `<div class="item-list">
        ${snapshot.boards
          .map(board => {
            const classes = [
              'board-row',
              this.selectedBoardId === board.id ? 'selected' : ''
            ]
              .filter(Boolean)
              .join(' ');
            const projectOrLocation =
              board.projectKey && board.projectName
                ? `${board.projectKey} • ${board.projectName}`
                : board.projectKey ?? board.locationName ?? '';
            const prefs = this.boardColumnStore.getPreferences(board.id);
            const metaPillStyle = buildMetaPillInlineStyle(prefs.projectPillColor);
            return `<div class="${classes}" data-board-id="${escapeHtml(board.id)}" title="${escapeHtml(board.name)}">
              <div class="row-main">
                <div class="row-left">
                  <span class="board-mode-icon" style="color: ${escapeHtml(modeIconColor)}">${modeIconMarkup}</span>
                  <div class="item-name">${escapeHtml(board.name)}</div>
                </div>
                <div class="row-right">
                  ${renderPill(board.type.toUpperCase(), boardTypeToken(board.type))}
                  ${projectOrLocation ? renderPill(projectOrLocation, 'meta', metaPillStyle) : ''}
                  <div class="row-actions">
                    ${renderIconButton(`editBoard-${board.id}`, 'Edit board', 'edit').replace(
                      'id="editBoard-' + board.id + '"',
                      `id="editBoard-${board.id}" data-edit-board-id="${escapeHtml(board.id)}"`
                    )}
                    ${renderIconButton(`deleteBoard-${board.id}`, 'Delete board', 'delete').replace(
                      'id="deleteBoard-' + board.id + '"',
                      `id="deleteBoard-${board.id}" data-delete-board-id="${escapeHtml(board.id)}"`
                    )}
                  </div>
                </div>
              </div>
            </div>`;
          })
          .join('')}
      </div>`;
    }

    this.view.title = undefined;
    const boardCount = snapshot.boards.length;
    this.view.description = String(boardCount);
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
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-sideBar-background);
      }
      .page {
        box-sizing: border-box;
        min-height: 100%;
        padding: 0;
      }
      .item-list {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .board-row {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 4px 6px;
        border-radius: 2px;
        cursor: pointer;
      }
      .board-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .board-row.selected {
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      }
      .row-main {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        min-height: 28px;
      }
      .row-left {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .board-mode-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      .board-mode-icon svg {
        width: 14px;
        height: 14px;
        display: block;
      }
      .row-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .item-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: 1px 6px;
        border: 1px solid transparent;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.4;
      }
      .pill--scrum {
        color: #93c5fd;
        background: rgba(59, 130, 246, 0.16);
        border-color: rgba(59, 130, 246, 0.28);
      }
      .pill--kanban {
        color: #86efac;
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(34, 197, 94, 0.28);
      }
      .pill--epic {
        color: #f9a8d4;
        background: rgba(236, 72, 153, 0.16);
        border-color: rgba(236, 72, 153, 0.28);
      }
      .pill--jql {
        color: #fde68a;
        background: rgba(245, 158, 11, 0.16);
        border-color: rgba(245, 158, 11, 0.28);
      }
      .pill--board,
      .pill--meta {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .row-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--vscode-icon-foreground, var(--vscode-editor-foreground));
        cursor: pointer;
      }
      .row-actions .icon-button {
        width: 24px;
        height: 24px;
      }
      .icon-button:hover {
        border-color: var(--vscode-widget-border, transparent);
        background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      }
      .icon-button svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .message {
        padding: 10px 0;
        border: 1px dashed var(--vscode-panel-border);
        border-radius: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .message.error {
        color: var(--vscode-errorForeground);
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${content}
    </div>
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      for (const row of document.querySelectorAll('[data-board-id]')) {
        row.addEventListener('click', () => {
          vscodeApi.postMessage({ type: 'selectBoard', boardId: row.getAttribute('data-board-id') });
        });
      }
      for (const button of document.querySelectorAll('[data-edit-board-id]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'editBoard', boardId: button.getAttribute('data-edit-board-id') });
        });
      }
      for (const button of document.querySelectorAll('[data-delete-board-id]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscodeApi.postMessage({ type: 'deleteBoard', boardId: button.getAttribute('data-delete-board-id') });
        });
      }
    </script>
  </body>
</html>`;
  }
}
