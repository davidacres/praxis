import * as vscode from 'vscode';
import type { GroupingMode, JiraFilters, PersistedFilterState } from '../types';

const FILTERS_KEY = 'jiraMini.filters';
const GROUPING_KEY = 'jiraMini.grouping';

const DEFAULT_FILTERS: JiraFilters = {
  projectKeys: [],
  statuses: [],
  issueTypes: [],
  searchText: '',
  assigneeMode: 'me',
  epicKey: undefined,
  grouping: 'project'
};

export class FilterStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<JiraFilters>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getFilters(): JiraFilters {
    const storedFilters =
      this.context.workspaceState.get<PersistedFilterState>(FILTERS_KEY) ?? {
        ...DEFAULT_FILTERS
      };
    const grouping = this.context.globalState.get<GroupingMode>(
      GROUPING_KEY,
      DEFAULT_FILTERS.grouping
    );

    return {
      projectKeys: [...(storedFilters.projectKeys ?? [])],
      statuses: [...(storedFilters.statuses ?? [])],
      issueTypes: [...(storedFilters.issueTypes ?? [])],
      searchText: storedFilters.searchText ?? '',
      assigneeMode: storedFilters.assigneeMode ?? 'me',
      epicKey: storedFilters.epicKey,
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

  public async updateFilters(patch: Partial<JiraFilters>): Promise<JiraFilters> {
    const current = this.getFilters();
    const next: JiraFilters = {
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

  public async setGrouping(grouping: GroupingMode): Promise<JiraFilters> {
    const current = this.getFilters();
    const next = { ...current, grouping };
    await this.persist(next, this.getLastSelectedIssueKey());
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  public async clearFilters(): Promise<JiraFilters> {
    const grouping = this.getFilters().grouping;
    const next = {
      ...DEFAULT_FILTERS,
      grouping
    };

    await this.persist(next, undefined);
    this.onDidChangeEmitter.fire(next);
    return next;
  }

  private async persist(filters: JiraFilters, lastSelectedIssueKey: string | undefined): Promise<void> {
    const persisted: PersistedFilterState = {
      projectKeys: filters.projectKeys,
      statuses: filters.statuses,
      issueTypes: filters.issueTypes,
      searchText: filters.searchText,
      assigneeMode: filters.assigneeMode,
      epicKey: filters.epicKey,
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
