import { Emitter, type Disposable } from '../host/emitter';
import type { HostStorage } from '../host/stateStore';
import type { BoardFilters, PersistedBoardFilterState, TrackedBoardRef } from '../types';

const BOARD_FILTERS_KEY = 'ticketManager.boards.filters';
const WORK_MODE_LAYOUT_KEY = 'ticketManager.workMode.layout';

interface PersistedWorkModeLayout {
  boardOrder?: string[];
  groupByProvider?: boolean;
}

const DEFAULT_BOARD_FILTERS: BoardFilters = {
  projectKeys: [],
  types: [],
  searchText: ''
};

export class BoardStore implements Disposable {
  private readonly onDidChangeEmitter = new Emitter<BoardFilters>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly storage: HostStorage) {}

  public getFilters(): BoardFilters {
    const storedFilters =
      this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    return {
      projectKeys: [...(storedFilters.projectKeys ?? [])],
      types: [...(storedFilters.types ?? [])],
      searchText: storedFilters.searchText ?? ''
    };
  }

  public getLastSelectedBoardId(): string | undefined {
    return this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY)?.lastSelectedBoardId;
  }

  public async setLastSelectedBoardId(boardId: string | undefined): Promise<void> {
    const storedFilters =
      this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    storedFilters.lastSelectedBoardId = boardId;
    await this.storage.workspace.update(BOARD_FILTERS_KEY, storedFilters);
  }

  public getLastSelectedTrackedBoard(): TrackedBoardRef | undefined {
    const stored = this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY);
    if (!stored?.lastSelectedBoardId || !stored.lastSelectedConnectionId) {
      return undefined;
    }
    return { connectionId: stored.lastSelectedConnectionId, boardId: stored.lastSelectedBoardId };
  }

  public async setLastSelectedTrackedBoard(ref: TrackedBoardRef | undefined): Promise<void> {
    const storedFilters =
      this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY) ?? {
        ...DEFAULT_BOARD_FILTERS
      };

    storedFilters.lastSelectedBoardId = ref?.boardId;
    storedFilters.lastSelectedConnectionId = ref?.connectionId;
    await this.storage.workspace.update(BOARD_FILTERS_KEY, storedFilters);
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

  public getWorkModeBoardOrder(): string[] {
    const stored = this.storage.workspace.get<PersistedWorkModeLayout>(WORK_MODE_LAYOUT_KEY);
    return [...(stored?.boardOrder ?? [])];
  }

  public async setWorkModeBoardOrder(order: string[]): Promise<void> {
    const current = this.storage.workspace.get<PersistedWorkModeLayout>(WORK_MODE_LAYOUT_KEY) ?? {};
    await this.storage.workspace.update(WORK_MODE_LAYOUT_KEY, {
      ...current,
      boardOrder: [...order]
    } satisfies PersistedWorkModeLayout);
  }

  public getWorkModeGroupByProvider(): boolean {
    return this.storage.workspace.get<PersistedWorkModeLayout>(WORK_MODE_LAYOUT_KEY)?.groupByProvider ?? false;
  }

  public async setWorkModeGroupByProvider(value: boolean): Promise<void> {
    const current = this.storage.workspace.get<PersistedWorkModeLayout>(WORK_MODE_LAYOUT_KEY) ?? {};
    await this.storage.workspace.update(WORK_MODE_LAYOUT_KEY, {
      ...current,
      groupByProvider: value
    } satisfies PersistedWorkModeLayout);
  }

  private async persist(
    filters: BoardFilters,
    lastSelectedBoardId: string | undefined
  ): Promise<void> {
    const current = this.storage.workspace.get<PersistedBoardFilterState>(BOARD_FILTERS_KEY);
    const persisted: PersistedBoardFilterState = {
      projectKeys: filters.projectKeys,
      types: filters.types,
      searchText: filters.searchText,
      lastSelectedBoardId,
      lastSelectedConnectionId: current?.lastSelectedConnectionId
    };

    await this.storage.workspace.update(BOARD_FILTERS_KEY, persisted);
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
