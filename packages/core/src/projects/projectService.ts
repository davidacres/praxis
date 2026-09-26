import type { IssueTrackerService } from '../backends/issueTrackerService';
import type {
  Board, BoardDetails, BoardFilters, ConnectionCheck, CreateBoardInput, CreateIssueInput,
  FilterMetadata, IssueAttachment, IssueDetails, IssueFilters, IssueSummary, PagedIssues,
  ParentIssueReference, ParentItemQueryOptions, Project, UpdateBoardInput, UpdateIssueInput, WorkflowTransition
} from '../types';
import {
  buildParentValidationMessage, getParentRule, isAllowedParentType, normalizeIssueTypeLabel
} from '../issues/issueHierarchy';
import type { ProjectRecord, ProjectWorkItem } from './projectTypes';
import { ProjectStore } from './projectStore';

export const projectConnectionId = (projectId: string) => `project:${projectId}`;

/**
 * The backend for a project's board.
 *
 * Only app-owned projects use this local service. Folder-backed projects are
 * ordinary folder connections and resolve through `FolderService` directly.
 */
export function createProjectService(store: ProjectStore, projectId: string): IssueTrackerService {
  return new ProjectIssueTrackerService(store, projectId);
}

export class ProjectIssueTrackerService implements IssueTrackerService {
  public readonly mode = 'app' as const;
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
  public async getParentItems(filters: IssueFilters, searchText?: string, options?: ParentItemQueryOptions): Promise<IssueSummary[]> {
    const allowedParentTypes = options?.childIssueType
      ? getParentRule(options.childIssueType, this.mode).allowedParentTypes
      : [];
    const needle = searchText?.trim().toLowerCase();
    return this.filtered(filters)
      .filter(item => allowedParentTypes.length === 0
        || allowedParentTypes.some(type => type.toLowerCase() === item.issueType.toLowerCase()))
      .filter(item => !needle || `${item.key} ${item.summary}`.toLowerCase().includes(needle));
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
    const issueType = input.issueType.trim() || 'Task';
    const parentKey = input.parentKey?.trim() || undefined;
    this.validateParentSelection(project, issueType, parentKey);
    const now = new Date().toISOString();
    const item: ProjectWorkItem = {
      id: `${project.id}-item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key: `${project.key}-${nextSequence(project)}`, summary: input.summary.trim(),
      description: input.description?.trim() ?? '', issueType,
      status: project.workflowStages[0].name, createdAt: now, updatedAt: now,
      ...(parentKey ? { parentKey } : {})
    };
    project.workItems.push(item); project.updatedAt = now; await this.store.replace(project);
    return this.getIssue(item.key);
  }
  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const project = this.requireProject(); const item = this.requireItem(project, issueKey);
    const hasParentPatch = Object.prototype.hasOwnProperty.call(input, 'parentKey');
    const nextIssueType = input.issueType?.trim() || item.issueType;
    const nextParentKey = hasParentPatch ? (input.parentKey?.trim() || undefined) : item.parentKey;
    this.validateParentSelection(project, nextIssueType, nextParentKey, item.key);
    if (input.summary !== undefined) item.summary = input.summary.trim();
    if (input.description !== undefined) item.description = input.description.trim();
    if (input.issueType !== undefined) item.issueType = input.issueType.trim();
    if (hasParentPatch) {
      if (nextParentKey) item.parentKey = nextParentKey;
      else delete item.parentKey;
    }
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
  private board(project: ProjectRecord): Board { return { id: project.defaultBoardId, name: `${project.name} Board`, type: 'project', createdAt: project.createdAt, projectKey: project.key, projectName: project.name, locationName: project.workspaceFolder, connectionId: projectConnectionId(project.id) }; }
  private issue(project: ProjectRecord, item: ProjectWorkItem): IssueSummary {
    const parent = item.parentKey ? project.workItems.find(candidate => candidate.key === item.parentKey) : undefined;
    return {
      id: item.id, key: item.key, summary: item.summary, description: item.description,
      issueType: item.issueType, status: item.status,
      statusCategory: item.status === project.workflowStages.at(-1)?.name ? 'done' : undefined,
      projectKey: project.key, projectName: project.name, created: item.createdAt, updated: item.updatedAt,
      ...(item.parentKey ? { parentKey: item.parentKey } : {}),
      ...(parent ? { parentIssue: toParentIssueReference(parent) } : {})
    };
  }
  /**
   * Mirrors `JiraService.validateParentSelection`: a Feature/Epic can't have
   * a parent, a Subtask must have one, everything else may optionally have
   * one — and whatever is given must exist in this project and be an
   * allowed type for the child (`getParentRule`'s two-tier model).
   */
  private validateParentSelection(
    project: ProjectRecord,
    issueType: string,
    parentKey: string | undefined,
    currentIssueKey?: string
  ): void {
    const rule = getParentRule(issueType, this.mode);
    const issueLabel = normalizeIssueTypeLabel(issueType);
    if (!rule.canHaveParent) {
      if (parentKey) throw new Error(`${issueLabel} items cannot have a parent.`);
      return;
    }
    if (!parentKey) {
      if (rule.requiresParent) throw new Error(`${rule.defaultLabel} is required for ${issueLabel} items.`);
      return;
    }
    if (parentKey === currentIssueKey) throw new Error('An item cannot be its own parent.');
    const parentItem = project.workItems.find(candidate => candidate.key === parentKey);
    if (!parentItem) throw new Error(`${rule.defaultLabel} ${parentKey} was not found.`);
    if (!isAllowedParentType(parentItem.issueType, issueType, this.mode)) {
      throw new Error(buildParentValidationMessage(issueType, this.mode, parentItem.issueType));
    }
  }
  private transitions(project: ProjectRecord, item: ProjectWorkItem): WorkflowTransition[] { return project.workflowStages.filter(stage => stage.name !== item.status).map(stage => ({ id: stage.id, name: `Move to ${stage.name}`, toStatus: stage.name })); }
  private filtered(filters: IssueFilters): IssueSummary[] { const project = this.requireProject(); let values = project.workItems.map(item => this.issue(project, item)); if (filters.projectKeys.length) values = values.filter(item => filters.projectKeys.includes(item.projectKey)); if (filters.statuses.length) values = values.filter(item => filters.statuses.includes(item.status)); if (filters.issueTypes.length) values = values.filter(item => filters.issueTypes.includes(item.issueType)); const needle = filters.searchText.trim().toLowerCase(); return needle ? values.filter(item => `${item.key} ${item.summary} ${item.description ?? ''}`.toLowerCase().includes(needle)) : values; }
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function nextSequence(project: ProjectRecord): number { return project.workItems.reduce((max, item) => Math.max(max, Number(item.key.match(/-(\d+)$/)?.[1] ?? 0)), 0) + 1; }
function toParentIssueReference(item: ProjectWorkItem): ParentIssueReference {
  return { key: item.key, summary: item.summary, issueType: item.issueType, description: item.description };
}
