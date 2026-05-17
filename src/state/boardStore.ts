import * as vscode from 'vscode';
import type { BoardFilters, PersistedBoardFilterState, TrackedBoardRef } from '../types';

const BOARD_FILTERS_KEY = 'ticketManager.boards.filters';

const DEFAULT_BOARD_FILTERS: BoardFilters = {
  projectKeys: [],
  types: [],
  searchText: ''
};

export class BoardStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<BoardFilters>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getFilters(): BoardFilters {
    const storedFilters =
      this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    return {
      projectKeys: [...(storedFilters.projectKeys ?? [])],
      types: [...(storedFilters.types ?? [])],
      searchText: storedFilters.searchText ?? ''
    };
  }

  public getLastSelectedBoardId(): string | undefined {
    return this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY)?.lastSelectedBoardId;
  }

  public async setLastSelectedBoardId(boardId: string | undefined): Promise<void> {
    const storedFilters =
      this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    storedFilters.lastSelectedBoardId = boardId;
    await this.context.workspaceState.update(BOARD_FILTERS_KEY, storedFilters);
  }

  public getLastSelectedTrackedBoard(): TrackedBoardRef | undefined {
    const stored = this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY);
    if (!stored?.lastSelectedBoardId || !stored.lastSelectedConnectionId) {
      return undefined;
    }
    return { connectionId: stored.lastSelectedConnectionId, boardId: stored.lastSelectedBoardId };
  }

  public async setLastSelectedTrackedBoard(ref: TrackedBoardRef | undefined): Promise<void> {
    const storedFilters =
      this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    storedFilters.lastSelectedBoardId = ref?.boardId;
    storedFilters.lastSelectedConnectionId = ref?.connectionId;
    await this.context.workspaceState.update(BOARD_FILTERS_KEY, storedFilters);
  }

  public async updateFilters(patch: Partial<BoardFilters>): Promise<BoardFilters> {
    const current = this.getFilters();
    const next: BoardFilters = {
      ...current,
      ...patch,
      projectKeys: patch.projectKeys ? [...patch.projectKeys] : current.projectKeys,
      types: patch.types ? [...patch.types] : current.types
    };

    await this.persist(next, this.getLastSelectedBoardId());
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  public async clearFilters(): Promise<BoardFilters> {
    const next = {
      ...DEFAULT_BOARD_FILTERS
    };

    await this.persist(next, this.getLastSelectedBoardId());
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  private async persist(
    filters: BoardFilters,
    lastSelectedBoardId: string | undefined
  ): Promise<void> {
    const current = this.context.workspaceState.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY);
    const persisted: PersistedBoardFilterState = {
      projectKeys: filters.projectKeys,
      types: filters.types,
      searchText: filters.searchText,
      lastSelectedBoardId,
      lastSelectedConnectionId: current?.lastSelectedConnectionId
    };

    await this.context.workspaceState.update(BOARD_FILTERS_KEY, persisted);
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
