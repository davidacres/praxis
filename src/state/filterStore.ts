import * as vscode from 'vscode';
import type { GroupingMode, IssueFilters, PersistedFilterState } from '../types';

const FILTERS_KEY = 'ticketManager.filters';
const GROUPING_KEY = 'ticketManager.grouping';

const DEFAULT_FILTERS: IssueFilters = {
  projectKeys: [],
  statuses: [],
  issueTypes: [],
  searchText: '',
  assigneeMode: 'me',
  parentKey: undefined,
  grouping: 'none'
};

export class FilterStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<IssueFilters>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getFilters(): IssueFilters {
    const storedFilters =
      this.context.workspaceState.get<PersistedFilterState>(FILTERS_KEY) ?? {
        ...DEFAULT_FILTERS
      };
    const storedGrouping = this.context.globalState.get<GroupingMode>(GROUPING_KEY);
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
    return this.context.workspaceState.get<PersistedFilterState>(FILTERS_KEY)?.lastSelectedIssueKey;
  }

  public async setLastSelectedIssueKey(key: string | undefined): Promise<void> {
    const filters = this.context.workspaceState.get<PersistedFilterState>(FILTERS_KEY) ?? {
      ...DEFAULT_FILTERS
    };
    filters.lastSelectedIssueKey = key;
    await this.context.workspaceState.update(FILTERS_KEY, filters);
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
      this.context.workspaceState.update(FILTERS_KEY, persisted),
      this.context.globalState.update(GROUPING_KEY, filters.grouping)
    ]);
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
