import type { IssueTrackerService } from '../backends/issueTrackerService';
import { identifyPlanFolder } from '../livefolder/markdownPlanParser';
import { toStoredFolderPath } from '../livefolder/pathUtils';
import {
  LiveFolderService,
  type LiveFolderConfigProvider
} from '../livefolder/liveFolderService';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  ParentItemQueryOptions,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import {
  UserWorkspaceStore,
  type UserWorkspaceBoardDefinition
} from './userWorkspaceStore';

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function createBoardSummary(definition: UserWorkspaceBoardDefinition): Board {
  return {
    id: definition.id,
    name: definition.name,
    type: 'plan',
    projectKey: definition.projectKey,
    projectName: definition.projectName,
    locationName: definition.liveFolderPath
  };
}

function normalizeProjectKey(value: string): string {
  return value.trim().toUpperCase();
}

function validateProjectKey(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(value)) {
    throw new Error(
      'Project key must use letters, numbers, or underscore; 1-15 characters and start with a letter.'
    );
  }
}

class UserWorkspaceLiveFolderConfigProvider implements LiveFolderConfigProvider {
  public constructor(
    private readonly appConfigStore: UserWorkspaceConfigProvider,
    private readonly definition: UserWorkspaceBoardDefinition
  ) {}

  public getDefaultPageSize(): number {
    return this.appConfigStore.getDefaultPageSize();
  }

  public getLiveFolderPath(): string {
    return this.definition.liveFolderPath;
  }

  public getLiveFolderProjectKey(): string {
    return this.definition.projectKey;
  }

  public getLiveFolderProjectName(): string {
    return this.definition.projectName;
  }

  public getLiveFolderAllowIssueCreation(): boolean {
    return this.appConfigStore.getLiveFolderAllowIssueCreation();
  }
}

export interface UserWorkspaceConfigProvider {
  getDefaultPageSize(): number;
  getLiveFolderAllowIssueCreation(): boolean;
}

export class UserWorkspaceService implements IssueTrackerService {
  public readonly mode: BackendMode = 'userworkspace';

  private readonly boardServices = new Map<string, LiveFolderService>();

  public constructor(
    private readonly configStore: UserWorkspaceConfigProvider,
    private readonly userWorkspaceStore: UserWorkspaceStore
  ) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.syncServiceCache();
    await Promise.all(
      [...this.boardServices.values()].map(async service => {
        await service.reset();
      })
    );
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    const boards = this.userWorkspaceStore.getBoards();
    if (boards.length === 0) {
      return {
        status: 'warning',
        message:
          'User Workspace is configured, but no boards have been added yet. Use Create Board to add a plans folder.',
        toolCount: 0,
        projectCount: 0
      };
    }

    try {
      const checks = await Promise.all(
        boards.map(async definition => {
          const service = this.getOrCreateBoardService(definition);
          return {
            definition,
            result: await service.checkConnection()
          };
        })
      );
      const failed = checks.find(entry => entry.result.status === 'error');
      if (failed) {
        return {
          status: 'error',
          message: `${failed.definition.name}: ${failed.result.message}`,
          toolCount: 0,
          projectCount: boards.length
        };
      }
      const warning = checks.find(entry => entry.result.status === 'warning');
      if (warning) {
        return {
          status: 'warning',
          message: `${warning.definition.name}: ${warning.result.message}`,
          toolCount: 0,
          projectCount: boards.length
        };
      }
      return {
        status: 'ok',
        message: `User Workspace: ${boards.length} board${boards.length === 1 ? '' : 's'} across ${boards.length} project${boards.length === 1 ? '' : 's'}.`,
        toolCount: 0,
        projectCount: boards.length
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        toolCount: 0,
        projectCount: boards.length
      };
    }
  }

  public async getProjects(): Promise<Project[]> {
    const boards = this.userWorkspaceStore.getBoards();
    const projects = new Map<string, Project>();
    for (const definition of boards) {
      projects.set(definition.projectKey, {
        key: definition.projectKey,
        name: definition.projectName
      });
    }
    return [...projects.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    const issues = await this.collectIssues(filters);
    const total = issues.length;
    return {
      issues: issues.slice(startAt, startAt + pageSize),
      total,
      hasMore: startAt + pageSize < total
    };
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    const metadata = await Promise.all(
      this.userWorkspaceStore.getBoards().map(async definition => {
        const service = this.getOrCreateBoardService(definition);
        return service.getFilterMetadata(filters);
      })
    );
    return {
      statuses: uniqueSorted(metadata.flatMap(entry => entry.statuses)),
      issueTypes: uniqueSorted(metadata.flatMap(entry => entry.issueTypes))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    const parentItems = await Promise.all(
      this.userWorkspaceStore.getBoards().map(async definition => {
        const service = this.getOrCreateBoardService(definition);
        return service.getParentItems(filters, searchText, options);
      })
    );
    const itemsByKey = new Map<string, IssueSummary>();
    for (const item of parentItems.flat()) {
      itemsByKey.set(item.key, item);
    }
    return [...itemsByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    let boards = this.userWorkspaceStore.getBoards().map(createBoardSummary);
    if (filters.projectKeys.length > 0) {
      const projectKeys = new Set(filters.projectKeys);
      boards = boards.filter(board => board.projectKey && projectKeys.has(board.projectKey));
    }
    if (filters.types.length > 0) {
      const types = new Set(filters.types.map(type => type.toLowerCase()));
      boards = boards.filter(board => types.has(board.type.toLowerCase()));
    }
    const searchText = filters.searchText.trim().toLowerCase();
    if (searchText) {
      boards = boards.filter(board => {
        const haystack = `${board.name} ${board.projectKey ?? ''} ${board.projectName ?? ''} ${board.locationName ?? ''}`.toLowerCase();
        return haystack.includes(searchText);
      });
    }
    return boards;
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const service = this.getBoardServiceByBoardId(board.id);
    const details = await service.getBoardDetails(board);
    return {
      ...details,
      board
    };
  }

  public async createBoard(input: CreateBoardInput): Promise<Board> {
    const name = input.name.trim();
    const projectKey = normalizeProjectKey(input.projectKey);
    const projectName = input.projectName?.trim() || name;
    const liveFolderPath = input.liveFolderPath?.trim();
    if (!name) {
      throw new Error('Board name cannot be empty.');
    }
    if (!projectName) {
      throw new Error('Project name cannot be empty.');
    }
    if (!liveFolderPath) {
      throw new Error('Plans folder path is required to create a user workspace board.');
    }
    validateProjectKey(projectKey);

    const identified = await identifyPlanFolder(liveFolderPath);
    const resolvedLiveFolderPath = toStoredFolderPath(identified.plansRootUri.fsPath);
    const existingBoards = this.userWorkspaceStore.getBoards();
    if (existingBoards.some(board => board.projectKey === projectKey)) {
      throw new Error(`Project key ${projectKey} is already used by another user workspace board.`);
    }
    if (existingBoards.some(board => board.liveFolderPath === resolvedLiveFolderPath)) {
      throw new Error(`The plans folder ${resolvedLiveFolderPath} is already added to the user workspace.`);
    }

    const created = await this.userWorkspaceStore.createBoard({
      name,
      projectKey,
      projectName,
      liveFolderPath: resolvedLiveFolderPath
    });

    try {
      const service = this.getOrCreateBoardService(created);
      const result = await service.checkConnection();
      if (result.status === 'error') {
        throw new Error(result.message);
      }
      return createBoardSummary(created);
    } catch (error) {
      this.disposeBoardService(created.id);
      await this.userWorkspaceStore.deleteBoard(created.id);
      throw error;
    }
  }

  public async updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board> {
    const name = input.name?.trim();
    if (!name) {
      throw new Error('Board name cannot be empty.');
    }
    const updated = await this.userWorkspaceStore.updateBoardName(boardId, name);
    return createBoardSummary(updated);
  }

  public async deleteBoard(boardId: string): Promise<void> {
    this.disposeBoardService(boardId);
    await this.userWorkspaceStore.deleteBoard(boardId);
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const service = await this.resolveIssueService(issueKey);
    return service.getIssue(issueKey);
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const service = this.resolveBoardServiceForCreate(input);
    return service.createIssue(input);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const service = await this.resolveIssueService(issueKey);
    return service.updateIssue(issueKey, input);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    const service = await this.resolveIssueService(issueKey);
    await service.deleteIssue(issueKey);
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const service = await this.resolveIssueService(issueKey);
    await service.addComment(issueKey, body);
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    const service = await this.resolveIssueService(issueKey);
    return service.getTransitions(issueKey);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const service = await this.resolveIssueService(issueKey);
    await service.transitionIssue(issueKey, transitionId);
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    const service = await this.resolveIssueService(issue.key);
    return service.getBrowseUrl(issue);
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  public dispose(): void {
    for (const service of this.boardServices.values()) {
      service.dispose();
    }
    this.boardServices.clear();
  }

  private async collectIssues(filters: IssueFilters): Promise<IssueSummary[]> {
    const issueLists = await Promise.all(
      this.userWorkspaceStore.getBoards().map(async definition => {
        const service = this.getOrCreateBoardService(definition);
        const result = await service.getIssues(filters, 0, Number.MAX_SAFE_INTEGER);
        return result.issues;
      })
    );
    return issueLists.flat();
  }

  private resolveBoardServiceForCreate(input: CreateIssueInput): LiveFolderService {
    if (input.boardId) {
      return this.getBoardServiceByBoardId(input.boardId);
    }
    const definition = this.userWorkspaceStore
      .getBoards()
      .find(candidate => candidate.projectKey === input.projectKey);
    if (!definition) {
      throw new Error(`No user workspace board was found for project ${input.projectKey}.`);
    }
    return this.getOrCreateBoardService(definition);
  }

  private getBoardServiceByBoardId(boardId: string): LiveFolderService {
    const definition = this.userWorkspaceStore.getBoard(boardId);
    if (!definition) {
      throw new Error(`Board ${boardId} was not found in the user workspace.`);
    }
    return this.getOrCreateBoardService(definition);
  }

  private getOrCreateBoardService(definition: UserWorkspaceBoardDefinition): LiveFolderService {
    this.syncServiceCache();
    const existing = this.boardServices.get(definition.id);
    if (existing) {
      return existing;
    }
    const service = new LiveFolderService(
      new UserWorkspaceLiveFolderConfigProvider(this.configStore, definition)
    );
    this.boardServices.set(definition.id, service);
    return service;
  }

  private syncServiceCache(): void {
    const activeBoardIds = new Set(this.userWorkspaceStore.getBoards().map(board => board.id));
    for (const boardId of [...this.boardServices.keys()]) {
      if (!activeBoardIds.has(boardId)) {
        this.disposeBoardService(boardId);
      }
    }
  }

  private disposeBoardService(boardId: string): void {
    const service = this.boardServices.get(boardId);
    service?.dispose();
    this.boardServices.delete(boardId);
  }

  private async resolveIssueService(issueKey: string): Promise<LiveFolderService> {
    for (const definition of this.userWorkspaceStore.getBoards()) {
      const service = this.getOrCreateBoardService(definition);
      try {
        await service.getIssue(issueKey);
        return service;
      } catch {
        // Try the next board until a matching issue is found.
      }
    }
    throw new Error(`Issue ${issueKey} was not found in the user workspace.`);
  }
}
