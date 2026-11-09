import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  Connection,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueAttachment,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  ParentItemQueryOptions,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition,
  IssueTrackerService
} from '@praxis/core';
import { getRustHostBridge } from '../rustHostInstance';

export interface RustTrackerConnectionPayload {
  mode: BackendMode;
  folderConfig?: {
    defaultPageSize?: number;
    folderRoots: string[];
    projectKey?: string;
    projectName?: string;
    allowIssueCreation?: boolean;
    aiDefaultModel?: string;
    prefersConfiguredIdentity?: boolean;
  };
  githubConfig?: {
    defaultPageSize?: number;
    apiUrl?: string;
    owner?: string;
    repo?: string;
    apiKey?: string;
    allowIssueCreation?: boolean;
  };
  gitlabConfig?: {
    defaultPageSize?: number;
    url?: string;
    projectPath?: string;
    listAllAccessibleBoards?: boolean;
    selectedBoardRefs?: string[];
    apiKey?: string;
    allowIssueCreation?: boolean;
  };
}

export function buildRustTrackerPayload(
  connection: Connection,
  secretApiKey?: string
): RustTrackerConnectionPayload {
  const settings =
    typeof connection.settings === 'object' && connection.settings !== null
      ? (connection.settings as Record<string, unknown>)
      : {};

  if (connection.mode === 'folder') {
    const rawRoots = settings['roots'];
    const roots: string[] = Array.isArray(rawRoots)
      ? rawRoots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : typeof settings['path'] === 'string' && settings['path'].trim().length > 0
        ? [settings['path'].trim()]
        : [];
    return {
      mode: 'folder',
      folderConfig: {
        folderRoots: roots,
        projectKey: typeof settings['projectKey'] === 'string' ? settings['projectKey'] : '',
        projectName: typeof settings['projectName'] === 'string' ? settings['projectName'] : '',
        allowIssueCreation: settings['allowIssueCreation'] === true,
        defaultPageSize: 25
      }
    };
  }

  if (connection.mode === 'github') {
    return {
      mode: 'github',
      githubConfig: {
        owner: typeof settings['owner'] === 'string' ? settings['owner'] : '',
        repo: typeof settings['repo'] === 'string' ? settings['repo'] : '',
        apiUrl: typeof settings['url'] === 'string' ? settings['url'] : '',
        apiKey: secretApiKey || (typeof settings['pat'] === 'string' ? settings['pat'] : ''),
        allowIssueCreation: settings['allowIssueCreation'] === true,
        defaultPageSize: 25
      }
    };
  }

  if (connection.mode === 'gitlab') {
    return {
      mode: 'gitlab',
      gitlabConfig: {
        url: typeof settings['url'] === 'string' ? settings['url'] : '',
        projectPath: typeof settings['projectPath'] === 'string' ? settings['projectPath'] : '',
        listAllAccessibleBoards: settings['listAllAccessibleBoards'] === true,
        selectedBoardRefs: Array.isArray(settings['selectedBoardRefs'])
          ? settings['selectedBoardRefs'].filter((s): s is string => typeof s === 'string')
          : [],
        apiKey: secretApiKey || (typeof settings['apiKey'] === 'string' ? settings['apiKey'] : ''),
        allowIssueCreation: settings['allowIssueCreation'] === true,
        defaultPageSize: 25
      }
    };
  }

  return {
    mode: connection.mode
  };
}

export class RustTrackerService implements IssueTrackerService {
  public readonly mode: BackendMode;
  private readonly payload: RustTrackerConnectionPayload;

  public constructor(connection: Connection, secretApiKey?: string) {
    this.mode = connection.mode;
    this.payload = buildRustTrackerPayload(connection, secretApiKey);
  }

  public getDefaultPageSize(): number {
    return 25;
  }

  public async reset(): Promise<void> {
    await getRustHostBridge().invoke('tracker:reset', this.payload);
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    return getRustHostBridge().invoke<ConnectionCheck>('tracker:checkConnection', this.payload);
  }

  public async getProjects(forceRefresh?: boolean): Promise<Project[]> {
    return getRustHostBridge().invoke<Project[]>('tracker:getProjects', this.payload, forceRefresh ?? false);
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    return getRustHostBridge().invoke<PagedIssues>(
      'tracker:getIssues',
      this.payload,
      filters,
      startAt,
      pageSize
    );
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    return getRustHostBridge().invoke<FilterMetadata>(
      'tracker:getFilterMetadata',
      this.payload,
      filters
    );
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    return getRustHostBridge().invoke<IssueSummary[]>(
      'tracker:getParentItems',
      this.payload,
      filters,
      searchText,
      options
    );
  }

  public async supportsBoards(): Promise<boolean> {
    return getRustHostBridge().invoke<boolean>('tracker:supportsBoards', this.payload);
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    return getRustHostBridge().invoke<Board[]>('tracker:getBoards', this.payload, filters);
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    return getRustHostBridge().invoke<BoardDetails>('tracker:getBoardDetails', this.payload, board);
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Creating a board from the app is not supported for this backend.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('Updating a board from the app is not supported for this backend.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Deleting a board from the app is not supported for this backend.');
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    return getRustHostBridge().invoke<IssueDetails>('tracker:getIssue', this.payload, issueKey);
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    return getRustHostBridge().invoke<IssueDetails>('tracker:createIssue', this.payload, input);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    return getRustHostBridge().invoke<IssueDetails>(
      'tracker:updateIssue',
      this.payload,
      issueKey,
      input
    );
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    await getRustHostBridge().invoke('tracker:deleteIssue', this.payload, issueKey);
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    await getRustHostBridge().invoke('tracker:addComment', this.payload, issueKey, body);
  }

  public async attachFile(
    _issueKey: string,
    _filePath: string,
    _fileName?: string
  ): Promise<void> {
    throw new Error('Attaching files is not supported for this backend.');
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error('Downloading attachments is not supported for this backend.');
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    return getRustHostBridge().invoke<WorkflowTransition[]>(
      'tracker:getTransitions',
      this.payload,
      issueKey
    );
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await getRustHostBridge().invoke(
      'tracker:transitionIssue',
      this.payload,
      issueKey,
      transitionId
    );
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return getRustHostBridge().invoke<string | undefined>('tracker:getBrowseUrl', this.payload, issue);
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return getRustHostBridge().invoke<string | undefined>(
      'tracker:getSelfAssigneeLabel',
      this.payload
    );
  }

  public dispose(): void {
    // No-op
  }
}
