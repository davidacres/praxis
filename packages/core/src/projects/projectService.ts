import type { IssueTrackerService } from '../backends/issueTrackerService';
import type {
  Board, BoardDetails, BoardFilters, ConnectionCheck, CreateBoardInput, CreateIssueInput,
  FilterMetadata, IssueAttachment, IssueDetails, IssueFilters, IssueSummary, PagedIssues,
  ParentItemQueryOptions, Project, UpdateBoardInput, UpdateIssueInput, WorkflowTransition
} from '../types';
import type { ProjectRecord, ProjectWorkItem } from './projectTypes';
import { ProjectStore } from './projectStore';
import { FolderService, type FolderConfigProvider } from '../folder/folderService';

export const projectConnectionId = (projectId: string) => `project:${projectId}`;

/**
 * The backend for a project's board.
 *
 * `storage: 'app'` keeps work items in the project record (`ProjectIssueTrackerService`);
 * `storage: 'folder'` makes the markdown plans tree the source of truth and
 * delegates to `FolderService` (`FolderBackedProjectService`). Both report
 * `mode: 'project'` and present the project's own board identity, so callers
 * never have to care which storage is behind it.
 */
export function createProjectService(store: ProjectStore, projectId: string): IssueTrackerService {
  return store.get(projectId)?.storage === 'folder'
    ? new FolderBackedProjectService(store, projectId)
    : new ProjectIssueTrackerService(store, projectId);
}

export class ProjectIssueTrackerService implements IssueTrackerService {
  public readonly mode = 'project' as const;
  public constructor(private readonly store: ProjectStore, private readonly projectId: string) {}
  public dispose(): void {}
  public getDefaultPageSize(): number { return 100; }
  public async reset(): Promise<void> {}
  public async checkConnection(): Promise<ConnectionCheck> {
    return { status: 'ok', message: 'App-managed project storage is ready.', toolCount: 0, projectCount: 1 };
  }
  public async getProjects(): Promise<Project[]> {
    const value = this.requireProject();
    return [{ id: value.id, key: value.key, name: value.name }];
  }
  public async getIssues(filters: IssueFilters, startAt: number, pageSize: number): Promise<PagedIssues> {
    const issues = this.filtered(filters);
    return { issues: issues.slice(startAt, startAt + pageSize), total: issues.length, hasMore: startAt + pageSize < issues.length };
  }
  public async getFilterMetadata(_filters: IssueFilters): Promise<FilterMetadata> {
    const project = this.requireProject();
    return { statuses: project.workflowStages.map(stage => stage.name), issueTypes: unique(project.workItems.map(item => item.issueType)) };
  }
  public async getParentItems(filters: IssueFilters, searchText?: string, _options?: ParentItemQueryOptions): Promise<IssueSummary[]> {
    const needle = searchText?.trim().toLowerCase();
    return this.filtered(filters).filter(item => !needle || `${item.key} ${item.summary}`.toLowerCase().includes(needle));
  }
  public async supportsBoards(): Promise<boolean> { return true; }
  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const project = this.requireProject();
    const board = this.board(project);
    const needle = filters.searchText.trim().toLowerCase();
    if (filters.projectKeys.length && !filters.projectKeys.includes(project.key)) return [];
    if (filters.types.length && !filters.types.map(value => value.toLowerCase()).includes('project')) return [];
    if (needle && !`${board.name} ${project.key} ${project.name}`.toLowerCase().includes(needle)) return [];
    return [board];
  }
  public async getBoardDetails(_board: Board): Promise<BoardDetails> {
    const project = this.requireProject();
    const issues = project.workItems.map(item => this.issue(project, item));
    return {
      board: this.board(project), issues, columnStatusOrder: project.workflowStages.map(stage => stage.name),
      columns: project.workflowStages.map(stage => ({ id: stage.id, name: stage.name, issues: issues.filter(issue => issue.status === stage.name) }))
    };
  }
  public async createBoard(_input: CreateBoardInput): Promise<Board> { throw new Error('Every project has exactly one default local board.'); }
  public async updateBoard(_boardId: string, input: UpdateBoardInput): Promise<Board> {
    if (!input.name?.trim()) return this.board(this.requireProject());
    return this.board(await this.store.update(this.projectId, { name: input.name.trim() }));
  }
  public async deleteBoard(_boardId: string): Promise<void> { throw new Error('A project default board cannot be deleted.'); }
  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const project = this.requireProject();
    const item = this.requireItem(project, issueKey);
    return { ...this.issue(project, item), transitions: this.transitions(project, item), comments: [] };
  }
  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const project = this.requireProject();
    if (input.projectKey !== project.key) throw new Error(`Project ${input.projectKey} is not available.`);
    const now = new Date().toISOString();
    const item: ProjectWorkItem = {
      id: `${project.id}-item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key: `${project.key}-${nextSequence(project)}`, summary: input.summary.trim(),
      description: input.description?.trim() ?? '', issueType: input.issueType.trim() || 'Task',
      status: project.workflowStages[0].name, createdAt: now, updatedAt: now
    };
    project.workItems.push(item); project.updatedAt = now; await this.store.replace(project);
    return this.getIssue(item.key);
  }
  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const project = this.requireProject(); const item = this.requireItem(project, issueKey);
    if (input.summary !== undefined) item.summary = input.summary.trim();
    if (input.description !== undefined) item.description = input.description.trim();
    if (input.issueType !== undefined) item.issueType = input.issueType.trim();
    item.updatedAt = new Date().toISOString(); project.updatedAt = item.updatedAt;
    await this.store.replace(project); return this.getIssue(issueKey);
  }
  public async deleteIssue(issueKey: string): Promise<void> {
    const project = this.requireProject(); const count = project.workItems.length;
    project.workItems = project.workItems.filter(item => item.key !== issueKey);
    if (project.workItems.length === count) throw new Error(`Work item ${issueKey} was not found.`);
    project.updatedAt = new Date().toISOString(); await this.store.replace(project);
  }
  public async addComment(_issueKey: string, _body: string): Promise<void> { throw new Error('Comments are not available on local project tickets yet.'); }
  public async attachFile(_issueKey: string, _filePath: string, _fileName?: string): Promise<void> { throw new Error('Attachments are not available on local project tickets.'); }
  public async downloadAttachment(_issueKey: string, _attachment: IssueAttachment, _targetFilePath: string): Promise<void> { throw new Error('Attachments are not available on local project tickets.'); }
  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> { const project = this.requireProject(); return this.transitions(project, this.requireItem(project, issueKey)); }
  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const project = this.requireProject(); const item = this.requireItem(project, issueKey);
    const stage = project.workflowStages.find(candidate => candidate.id === transitionId);
    if (!stage) throw new Error(`Workflow stage ${transitionId} was not found.`);
    item.status = stage.name; item.updatedAt = new Date().toISOString(); project.updatedAt = item.updatedAt;
    await this.store.replace(project);
  }
  public async getBrowseUrl(_issue: IssueSummary): Promise<string | undefined> { return undefined; }
  public async getSelfAssigneeLabel(): Promise<string | undefined> { return undefined; }

  private requireProject(): ProjectRecord { const value = this.store.get(this.projectId); if (!value) throw new Error(`Project ${this.projectId} was not found.`); return value; }
  private requireItem(project: ProjectRecord, key: string): ProjectWorkItem { const item = project.workItems.find(candidate => candidate.key === key); if (!item) throw new Error(`Work item ${key} was not found.`); return item; }
  private board(project: ProjectRecord): Board { return { id: project.defaultBoardId, name: `${project.name} Board`, type: 'project', projectKey: project.key, projectName: project.name, locationName: project.workspaceFolder, connectionId: projectConnectionId(project.id) }; }
  private issue(project: ProjectRecord, item: ProjectWorkItem): IssueSummary { return { id: item.id, key: item.key, summary: item.summary, description: item.description, issueType: item.issueType, status: item.status, statusCategory: item.status === project.workflowStages.at(-1)?.name ? 'done' : undefined, projectKey: project.key, projectName: project.name, created: item.createdAt, updated: item.updatedAt }; }
  private transitions(project: ProjectRecord, item: ProjectWorkItem): WorkflowTransition[] { return project.workflowStages.filter(stage => stage.name !== item.status).map(stage => ({ id: stage.id, name: `Move to ${stage.name}`, toStatus: stage.name })); }
  private filtered(filters: IssueFilters): IssueSummary[] { const project = this.requireProject(); let values = project.workItems.map(item => this.issue(project, item)); if (filters.projectKeys.length) values = values.filter(item => filters.projectKeys.includes(item.projectKey)); if (filters.statuses.length) values = values.filter(item => filters.statuses.includes(item.status)); if (filters.issueTypes.length) values = values.filter(item => filters.issueTypes.includes(item.issueType)); const needle = filters.searchText.trim().toLowerCase(); return needle ? values.filter(item => `${item.key} ${item.summary} ${item.description ?? ''}`.toLowerCase().includes(needle)) : values; }
}

/**
 * A project whose work items are the markdown plans under its workspace folder.
 *
 * Everything issue-shaped is delegated to a `FolderService` pointed at that
 * folder. Board-shaped calls are *not* delegated: the folder service names its
 * own board `folder-<key>`, but this project's board must keep the project's
 * identity (`defaultBoardId`, `project:<id>` connection) or navigation and the
 * sidebar would lose it.
 */
class FolderBackedProjectService implements IssueTrackerService {
  public readonly mode = 'project' as const;
  private cached?: { folderPath: string; key: string; name: string; service: FolderService };

  public constructor(private readonly store: ProjectStore, private readonly projectId: string) {}

  public dispose(): void { this.cached?.service.dispose(); this.cached = undefined; }
  public getDefaultPageSize(): number { return 100; }
  public async reset(): Promise<void> { await this.folder().reset(); }
  public async checkConnection(): Promise<ConnectionCheck> { return this.folder().checkConnection(); }
  public async getProjects(): Promise<Project[]> {
    const project = this.requireProject();
    return [{ id: project.id, key: project.key, name: project.name }];
  }
  public async getIssues(filters: IssueFilters, startAt: number, pageSize: number): Promise<PagedIssues> {
    // The folder service keys its own root board, not this project's board id —
    // passing ours through would filter every issue out.
    return this.folder().getIssues({ ...filters, boardId: undefined }, startAt, pageSize);
  }
  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> { return this.folder().getFilterMetadata(filters); }
  public async getParentItems(filters: IssueFilters, searchText?: string, options?: ParentItemQueryOptions): Promise<IssueSummary[]> {
    return this.folder().getParentItems(filters, searchText, options);
  }
  public async supportsBoards(): Promise<boolean> { return true; }
  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const project = this.requireProject();
    const board = this.board(project);
    const needle = filters.searchText.trim().toLowerCase();
    if (filters.projectKeys.length && !filters.projectKeys.includes(project.key)) return [];
    if (filters.types.length && !filters.types.map(value => value.toLowerCase()).includes('project')) return [];
    if (needle && !`${board.name} ${project.key} ${project.name}`.toLowerCase().includes(needle)) return [];
    return [board];
  }
  public async getBoardDetails(_board: Board): Promise<BoardDetails> {
    const project = this.requireProject();
    const details = await this.folder().getBoardDetails(this.board(project));
    return { ...details, board: this.board(project) };
  }
  public async createBoard(_input: CreateBoardInput): Promise<Board> { throw new Error('Every project has exactly one default board.'); }
  public async updateBoard(_boardId: string, input: UpdateBoardInput): Promise<Board> {
    if (!input.name?.trim()) return this.board(this.requireProject());
    return this.board(await this.store.update(this.projectId, { name: input.name.trim() }));
  }
  public async deleteBoard(_boardId: string): Promise<void> { throw new Error('A project default board cannot be deleted.'); }
  public async getIssue(issueKey: string): Promise<IssueDetails> { return this.folder().getIssue(issueKey); }
  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    return this.folder().createIssue({ ...input, projectKey: this.requireProject().key, boardId: undefined });
  }
  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> { return this.folder().updateIssue(issueKey, input); }
  public async deleteIssue(issueKey: string): Promise<void> { await this.folder().deleteIssue(issueKey); }
  public async addComment(issueKey: string, body: string): Promise<void> { await this.folder().addComment(issueKey, body); }
  public async attachFile(issueKey: string, filePath: string, fileName?: string): Promise<void> { await this.folder().attachFile(issueKey, filePath, fileName); }
  public async downloadAttachment(issueKey: string, attachment: IssueAttachment, targetFilePath: string): Promise<void> {
    await this.folder().downloadAttachment(issueKey, attachment, targetFilePath);
  }
  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> { return this.folder().getTransitions(issueKey); }
  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> { await this.folder().transitionIssue(issueKey, transitionId); }
  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> { return this.folder().getBrowseUrl(issue); }
  public async getSelfAssigneeLabel(): Promise<string | undefined> { return undefined; }

  private requireProject(): ProjectRecord { const value = this.store.get(this.projectId); if (!value) throw new Error(`Project ${this.projectId} was not found.`); return value; }
  private board(project: ProjectRecord): Board {
    return { id: project.defaultBoardId, name: `${project.name} Board`, type: 'project', projectKey: project.key, projectName: project.name, locationName: project.workspaceFolder, connectionId: projectConnectionId(project.id) };
  }
  /** Rebuilt whenever the project's folder or identity changes, so a rename or move is picked up. */
  private folder(): FolderService {
    const project = this.requireProject();
    const folderPath = project.workspaceFolder;
    if (!folderPath) throw new Error(`Project ${project.name} is folder-backed but has no workspace folder.`);
    if (this.cached && this.cached.folderPath === folderPath && this.cached.key === project.key && this.cached.name === project.name) {
      return this.cached.service;
    }
    this.cached?.service.dispose();
    const config: FolderConfigProvider = {
      getDefaultPageSize: () => 100,
      getFolderRoots: () => [folderPath],
      getFolderProjectKey: () => project.key,
      getFolderProjectName: () => project.name,
      getFolderAllowIssueCreation: () => true,
      getAiDefaultModel: () => '',
      // The project record is the identity here — a `board.praxis.json` left in
      // the folder must not silently override the key chosen in the wizard.
      prefersConfiguredIdentity: () => true
    };
    const service = new FolderService(config);
    this.cached = { folderPath, key: project.key, name: project.name, service };
    return service;
  }
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function nextSequence(project: ProjectRecord): number { return project.workItems.reduce((max, item) => Math.max(max, Number(item.key.match(/-(\d+)$/)?.[1] ?? 0)), 0) + 1; }
