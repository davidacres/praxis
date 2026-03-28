import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { BoardStore } from '../state/boardStore';
import type { Board } from '../types';

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

function getBoardDescription(board: Board): string {
  const parts = [board.type.toUpperCase()];
  if (board.projectKey) {
    parts.push(board.projectKey);
  } else if (board.locationName) {
    parts.push(board.locationName);
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
    private readonly boardStore: BoardStore
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
    item.description = getBoardDescription(element.board);
    item.tooltip = [
      element.board.name,
      `Type: ${element.board.type}`,
      element.board.projectKey
        ? `Project: ${element.board.projectName ? `${element.board.projectKey} • ${element.board.projectName}` : element.board.projectKey}`
        : undefined,
      element.board.locationName ? `Location: ${element.board.locationName}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    item.iconPath = new vscode.ThemeIcon('project');
    return item;
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
      this.boards = await this.backendService.getBoards(this.boardStore.getFilters());

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
