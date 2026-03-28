import * as vscode from 'vscode';
import { BoardStore } from '../state/boardStore';
import type { Board } from '../types';
import { BoardsTreeProvider } from './boardsTreeProvider';

interface BoardsSidebarCallbacks {
  onSelectBoard: (boardId: string) => Promise<void>;
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

function renderPill(label: string, token: string): string {
  return `<span class="pill pill--${token}">${escapeHtml(label)}</span>`;
}

function boardTypeToken(boardType: string | undefined): string {
  const normalized = boardType?.trim().toLowerCase();
  if (normalized === 'scrum' || normalized === 'kanban') {
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
    private readonly callbacks: BoardsSidebarCallbacks
  ) {
    this.disposables.push(
      this.boardsProvider.onDidChangeTreeData(() => {
        this.render();
      }),
      this.boardStore.onDidChange(() => {
        this.render();
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
    if (payload.type !== 'selectBoard' || typeof payload.boardId !== 'string') {
      return;
    }

    await this.callbacks.onSelectBoard(payload.boardId);
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
            return `<div class="${classes}" data-board-id="${escapeHtml(board.id)}" title="${escapeHtml(board.name)}">
              <div class="row-main">
                <div class="item-name">${escapeHtml(board.name)}</div>
                ${renderPill(board.type.toUpperCase(), boardTypeToken(board.type))}
                ${projectOrLocation ? renderPill(projectOrLocation, 'meta') : ''}
              </div>
            </div>`;
          })
          .join('')}
      </div>`;
    }

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
        padding: 10px;
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
        border-radius: 4px;
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
        gap: 6px;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .item-name {
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
      .pill--board,
      .pill--meta {
        color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.18));
        border-color: transparent;
      }
      .message {
        padding: 10px;
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
    </script>
  </body>
</html>`;
  }
}
