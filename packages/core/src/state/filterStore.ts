import { Emitter, type Disposable } from '../host/emitter';
import type { HostStorage } from '../host/stateStore';
import type { GroupingMode, IssueFilters, PersistedFilterState } from '../types';

const FILTERS_KEY = 'ticketManager.filters';
const GROUPING_KEY = 'ticketManager.grouping';
const EPIC_STATUSES_KEY = 'ticketManager.epicStatuses';

const DEFAULT_FILTERS: IssueFilters = {
  projectKeys: [],
  statuses: [],
  issueTypes: [],
  searchText: '',
  assigneeMode: 'me',
  parentKey: undefined,
  grouping: 'none'
};

export function shouldAdoptJiraMcpEpicIssueScope(filters: IssueFilters): boolean {
  return (
    filters.assigneeMode === 'me' &&
    filters.projectKeys.length === 0 &&
    filters.statuses.length === 0 &&
    filters.issueTypes.length === 0 &&
    filters.searchText.trim().length === 0 &&
    !filters.parentKey
  );
}

export class FilterStore implements Disposable {
  private readonly onDidChangeEmitter = new Emitter<IssueFilters>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly storage: HostStorage) {}

  public getFilters(): IssueFilters {
    const storedFilters =
      this.storage.workspace.get<PersistedFilterState>(FILTERS_KEY) ?? {
        ...DEFAULT_FILTERS
      };
    const storedGrouping = this.storage.global.get<GroupingMode>(GROUPING_KEY);
    const grouping =
      storedGrouping === 'project'
        ? 'none'
        : storedGrouping ?? DEFAULT_FILTERS.grouping;

    return {
      projectKeys: [...(storedFilters.projectKeys ?? [])],
      statuses: [...(storedFilters.statuses ?? [])],
      issueTypes: [...(storedFilters.issueTypes ?? [])],
      searchText: storedFilters.searchText ?? '',
      assigneeMode: storedFilters.assigneeMode ?? 'me',
      parentKey: storedFilters.parentKey,
      grouping
    };
  }

  public getLastSelectedIssueKey(): string | undefined {
    return this.storage.workspace.get<PersistedFilterState>(FILTERS_KEY)?.lastSelectedIssueKey;
  }

  public getEpicStatuses(): string[] {
    return [...(this.storage.workspace.get<string[]>(EPIC_STATUSES_KEY) ?? [])];
  }

  public async setLastSelectedIssueKey(key: string | undefined): Promise<void> {
    const filters = this.storage.workspace.get<PersistedFilterState>(FILTERS_KEY) ?? {
      ...DEFAULT_FILTERS
    };
    filters.lastSelectedIssueKey = key;
    await this.storage.workspace.update(FILTERS_KEY, filters);
  }

  public async setEpicStatuses(statuses: string[]): Promise<string[]> {
    const next = [...statuses];
    await this.storage.workspace.update(EPIC_STATUSES_KEY, next);
    this.onDidChangeEmitter.fire(this.getFilters());
    return next;
  }

  public async updateFilters(patch: Partial<IssueFilters>): Promise<IssueFilters> {
    const current = this.getFilters();
    const next: IssueFilters = {
      ...current,
      ...patch,
      projectKeys: patch.projectKeys ? [...patch.projectKeys] : current.projectKeys,
      statuses: patch.statuses ? [...patch.statuses] : current.statuses,
      issueTypes: patch.issueTypes ? [...patch.issueTypes] : current.issueTypes
    };

    await this.persist(next, this.getLastSelectedIssueKey());
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  public async setGrouping(grouping: GroupingMode): Promise<IssueFilters> {
    const current = this.getFilters();
    const next = { ...current, grouping };
    await this.persist(next, this.getLastSelectedIssueKey());
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  public async clearFilters(): Promise<IssueFilters> {
    const grouping = this.getFilters().grouping;
    const next = {
      ...DEFAULT_FILTERS,
      grouping
    };

    await this.persist(next, undefined);
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  private async persist(filters: IssueFilters, lastSelectedIssueKey: string | undefined): Promise<void> {
    const persisted: PersistedFilterState = {
      projectKeys: filters.projectKeys,
      statuses: filters.statuses,
      issueTypes: filters.issueTypes,
      searchText: filters.searchText,
      assigneeMode: filters.assigneeMode,
      parentKey: filters.parentKey,
      lastSelectedIssueKey
    };

    await Promise.all([
      this.storage.workspace.update(FILTERS_KEY, persisted),
      this.storage.global.update(GROUPING_KEY, filters.grouping)
    ]);
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
