import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { BackendRouter } from '../backends/backendRouter';
import type { ConnectionStore } from '../config/connectionStore';
import { BoardStore } from '../state/boardStore';
import type { Board } from '../types';

export interface BoardsProviderSnapshot {
  boards: Board[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage?: string;
}

abstract class BaseNode {
  public constructor(
    public readonly id: string,
    public readonly contextValue: string
  ) {}
}

class MessageNode extends BaseNode {
  public constructor(
    id: string,
    public readonly label: string,
    public readonly severity: 'info' | 'warning' | 'error'
  ) {
    super(id, 'message');
  }
}

export class BoardNode extends BaseNode {
  public constructor(public readonly board: Board) {
    super(`board:${board.id}`, 'board');
  }
}

type TreeNode = BoardNode | MessageNode;

function getBoardDescription(board: Board, connectionName?: string): string {
  const parts = [board.type.toUpperCase()];
  if (board.projectKey) {
    parts.push(board.projectKey);
  } else if (board.locationName) {
    parts.push(board.locationName);
  }
  if (connectionName) {
    parts.push(connectionName);
  }
  return parts.join(' • ');
}

export class BoardsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private boards: Board[] = [];
  private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private errorMessage?: string;
  private requestGeneration = 0;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly boardStore: BoardStore,
    private readonly connectionStore?: ConnectionStore,
    private readonly backendRouter?: BackendRouter
  ) {}

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof MessageNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.contextValue = element.contextValue;
      item.iconPath =
        element.severity === 'error'
          ? new vscode.ThemeIcon('error')
          : element.severity === 'warning'
            ? new vscode.ThemeIcon('warning')
            : new vscode.ThemeIcon('info');
      return item;
    }

    const item = new vscode.TreeItem(element.board.name, vscode.TreeItemCollapsibleState.None);
    item.id = element.id;
    item.contextValue = element.contextValue;
    const connectionName = this.resolveConnectionName(element.board.connectionId);
    const showConnectionInDescription =
      connectionName !== undefined && this.hasMultipleConnectionsWithBoards();
    item.description = getBoardDescription(
      element.board,
      showConnectionInDescription ? connectionName : undefined
    );
    item.tooltip = [
      element.board.name,
      `Type: ${element.board.type}`,
      element.board.projectKey
        ? `Project: ${element.board.projectName ? `${element.board.projectKey} • ${element.board.projectName}` : element.board.projectKey}`
        : undefined,
      element.board.locationName ? `Location: ${element.board.locationName}` : undefined,
      connectionName ? `Connection: ${connectionName}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    item.iconPath = new vscode.ThemeIcon('project');
    return item;
  }

  private resolveConnectionName(connectionId: string | undefined): string | undefined {
    if (!connectionId || !this.connectionStore) {
      return undefined;
    }
    return this.connectionStore.getConnection(connectionId)?.name;
  }

  private hasMultipleConnectionsWithBoards(): boolean {
    const ids = new Set<string>();
    for (const b of this.boards) {
      if (b.connectionId) {
        ids.add(b.connectionId);
      }
    }
    return ids.size > 1;
  }

  public async getChildren(): Promise<TreeNode[]> {
    if (this.status === 'idle') {
      void this.refresh();
      return [new MessageNode('loading', 'Loading boards...', 'info')];
    }

    if (this.status === 'loading' && this.boards.length === 0) {
      return [new MessageNode('loading', 'Loading boards...', 'info')];
    }

    if (this.status === 'error') {
      return [
        new MessageNode(
          'error',
          this.errorMessage ?? 'Unable to load boards.',
          'error'
        )
      ];
    }

    if (this.boards.length === 0) {
      return [this.buildEmptyNode()];
    }

    return this.boards.map(board => new BoardNode(board));
  }

  public async refresh(): Promise<void> {
    const generation = ++this.requestGeneration;
    this.status = 'loading';
    this.errorMessage = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);

    try {
      this.boards = await this.loadBoards();

      if (generation !== this.requestGeneration) {
        return;
      }

      this.status = 'ready';
      this.errorMessage = undefined;
    } catch (error) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.boards = [];
    } finally {
      if (generation === this.requestGeneration) {
        this.onDidChangeTreeDataEmitter.fire(undefined);
      }
    }
  }

  public getCurrentBoards(): Board[] {
    return [...this.boards];
  }

  /**
   * In single-backend (legacy) mode, returns boards from the global service.
   * In connections mode, returns only boards explicitly tracked in
   * Connections & Boards. It fetches each tracked connection in parallel,
   * filters to tracked ids, and tags each returned `Board` with its
   * `connectionId`.
   */
  private async loadBoards(): Promise<Board[]> {
    const filters = this.boardStore.getFilters();
    if (!this.connectionStore || !this.backendRouter) {
      return this.backendService.getBoards(filters);
    }

    const tracked = this.connectionStore.getTrackedBoards();
    if (tracked.length === 0) {
      // In connections mode, only tracked boards are shown.
      return [];
    }

    const byConnection = new Map<string, Set<string>>();
    for (const t of tracked) {
      let set = byConnection.get(t.connectionId);
      if (!set) {
        set = new Set<string>();
        byConnection.set(t.connectionId, set);
      }
      set.add(t.boardId);
    }

    const results = await Promise.all(
      Array.from(byConnection.entries()).map(async ([connectionId, trackedIds]) => {
        try {
          const service = await this.backendRouter!.serviceFor(connectionId);
          const boards = await service.getBoards(filters);
          return boards
            .filter(b => trackedIds.has(b.id))
            .map(b => ({ ...b, connectionId }));
        } catch {
          // Fall back to synthesizing minimal boards from tracked entries so
          // a single failing connection doesn't hide the rest.
          const tb = this.connectionStore!.getTrackedBoardsForConnection(connectionId);
          return tb
            .filter(t => trackedIds.has(t.boardId))
            .map(t => ({
              id: t.boardId,
              name: t.displayName ?? t.boardId,
              type: 'unknown',
              connectionId
            } satisfies Board));
        }
      })
    );
    return results.flat();
  }

  public getSnapshot(): BoardsProviderSnapshot {
    return {
      boards: [...this.boards],
      status: this.status,
      errorMessage: this.errorMessage
    };
  }

  public getBoardById(boardId: string): Board | undefined {
    return this.boards.find(board => board.id === boardId);
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private buildEmptyNode(): MessageNode {
    const filters = this.boardStore.getFilters();
    if (filters.searchText.trim().length > 0) {
      return new MessageNode(
        'empty',
        `No boards match "${filters.searchText.trim()}".`,
        'warning'
      );
    }

    if (filters.projectKeys.length > 0 || filters.types.length > 0) {
      return new MessageNode('empty', 'No boards match the current board filters.', 'warning');
    }

    return new MessageNode('empty', 'No boards are available.', 'warning');
  }
}
