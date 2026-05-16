import * as vscode from 'vscode';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueAttachment,
  IssueDetails,
  IssueFilters,
  ParentItemQueryOptions,
  IssueSummary,
  PagedIssues,
  Project,
  SubTaskSummary,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import { AppConfigStore } from '../config/jiraConfig';
import { DemoService } from '../demo/demoService';
import { GitLabBoardService } from '../gitlab/gitLabBoardService';
import { inferGitLabProjectFromRepo } from '../gitlab/gitLabApiService';
import { JiraApiService } from '../jira/jiraApiService';
import { JiraService } from '../jira/jiraService';
import { LiveFolderService, type ExternalCommentEvent } from '../livefolder/liveFolderService';
import { UserWorkspaceService } from '../userWorkspace/userWorkspaceService';
import { UserWorkspaceStore } from '../userWorkspace/userWorkspaceStore';
import type { IssueTrackerService } from './issueTrackerService';

function buildUnsupportedBackendMessage(mode: 'github' | 'gitlab'): string {
  const label = mode === 'github' ? 'GitHub' : 'GitLab';
  return `${label} project mode is not implemented yet. Current ${label} support is limited to setup metadata and repository automation helpers.`;
}

class UnsupportedBackendService implements IssueTrackerService {
  public readonly mode: BackendMode;
  private readonly unsupportedMode: 'github' | 'gitlab';

  public constructor(
    mode: 'github' | 'gitlab',
    private readonly defaultPageSize: number
  ) {
    this.unsupportedMode = mode;
    this.mode = mode;
  }

  public getDefaultPageSize(): number {
    return this.defaultPageSize;
  }

  public async reset(): Promise<void> {}

  public async checkConnection(): Promise<ConnectionCheck> {
    return {
      status: 'error',
      message: buildUnsupportedBackendMessage(this.unsupportedMode),
      toolCount: 0
    };
  }

  public async getProjects(): Promise<Project[]> {
    return [];
  }

  public async getIssues(): Promise<PagedIssues> {
    return {
      issues: [],
      total: 0,
      hasMore: false
    };
  }

  public async getFilterMetadata(): Promise<FilterMetadata> {
    return {
      statuses: [],
      issueTypes: []
    };
  }

  public async getParentItems(): Promise<IssueSummary[]> {
    return [];
  }

  public async supportsBoards(): Promise<boolean> {
    return false;
  }

  public async getBoards(): Promise<Board[]> {
    return [];
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    return {
      board,
      columns: [],
      issues: []
    };
  }

  public async createBoard(): Promise<Board> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async updateBoard(): Promise<Board> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async deleteBoard(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    throw new Error(`Cannot load ${issueKey}. ${buildUnsupportedBackendMessage(this.unsupportedMode)}`);
  }

  public async createIssue(): Promise<IssueDetails> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async updateIssue(): Promise<IssueDetails> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async deleteIssue(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async addComment(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async attachFile(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async downloadAttachment(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async getTransitions(): Promise<WorkflowTransition[]> {
    return [];
  }

  public async transitionIssue(): Promise<void> {
    throw new Error(buildUnsupportedBackendMessage(this.unsupportedMode));
  }

  public async getBrowseUrl(): Promise<string | undefined> {
    return undefined;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  public dispose(): void {}
}

export class BackendRouter implements IssueTrackerService {
  private activeMode?: BackendMode;
  private activeService?: IssueTrackerService;
  private readonly userWorkspaceStore: UserWorkspaceStore;
  private readonly _onDidReceiveExternalComment = new vscode.EventEmitter<ExternalCommentEvent>();
  public readonly onDidReceiveExternalComment = this._onDidReceiveExternalComment.event;
  private externalCommentSub?: vscode.Disposable;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly output: vscode.OutputChannel
  ) {
    this.userWorkspaceStore = new UserWorkspaceStore(context.globalState);
  }

  public get mode(): BackendMode {
    return this.configStore.getEffectiveBackendMode();
  }

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    const configuredMode = this.configStore.getEffectiveBackendMode();
    if (!this.activeService) {
      return;
    }

    if (this.activeMode !== configuredMode) {
      this.disposeActiveService();
      return;
    }

    await this.activeService.reset();
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    return (await this.getService()).checkConnection();
  }

  public async getProjects(forceRefresh = false): Promise<Project[]> {
    return (await this.getService()).getProjects(forceRefresh);
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    return (await this.getService()).getIssues(filters, startAt, pageSize);
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    return (await this.getService()).getFilterMetadata(filters);
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    return (await this.getService()).getParentItems(filters, searchText, options);
  }

  public async supportsBoards(): Promise<boolean> {
    return (await this.getService()).supportsBoards();
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    return (await this.getService()).getBoards(filters);
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    return (await this.getService()).getBoardDetails(board);
  }

  public async createBoard(input: CreateBoardInput): Promise<Board> {
    return (await this.getService()).createBoard(input);
  }

  public async updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board> {
    return (await this.getService()).updateBoard(boardId, input);
  }

  public async deleteBoard(boardId: string): Promise<void> {
    return (await this.getService()).deleteBoard(boardId);
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    return (await this.getService()).getIssue(issueKey);
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    return (await this.getService()).createIssue(input);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    return (await this.getService()).updateIssue(issueKey, input);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    return (await this.getService()).deleteIssue(issueKey);
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    return (await this.getService()).addComment(issueKey, body);
  }

  public async attachFile(issueKey: string, filePath: string, fileName?: string): Promise<void> {
    return (await this.getService()).attachFile(issueKey, filePath, fileName);
  }

  public async downloadAttachment(
    issueKey: string,
    attachment: IssueAttachment,
    targetFilePath: string
  ): Promise<void> {
    return (await this.getService()).downloadAttachment(issueKey, attachment, targetFilePath);
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    return (await this.getService()).getTransitions(issueKey);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    return (await this.getService()).transitionIssue(issueKey, transitionId);
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return (await this.getService()).getBrowseUrl(issue);
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return (await this.getService()).getSelfAssigneeLabel();
  }

  public async getSubTasks(parentKey: string): Promise<SubTaskSummary[]> {
    const service = await this.getService();
    if (service.getSubTasks) {
      return service.getSubTasks(parentKey);
    }
    return [];
  }

  public async createSubTasks(
    parentKey: string,
    projectKey: string,
    subTasks: Array<{ summary: string; description: string; issueType?: string }>
  ): Promise<string[]> {
    const service = await this.getService();
    if (service.createSubTasks) {
      return service.createSubTasks(parentKey, projectKey, subTasks);
    }
    throw new Error('Sub-task creation is not supported by the current backend.');
  }

  public dispose(): void {
    this.disposeActiveService();
    this._onDidReceiveExternalComment.dispose();
  }

  private async getService(): Promise<IssueTrackerService> {
    const configuredMode = this.configStore.getEffectiveBackendMode();
    if (this.activeService && this.activeMode === configuredMode) {
      return this.activeService;
    }

    this.disposeActiveService();
    this.activeMode = configuredMode;
    this.activeService =
      configuredMode === 'github'
        ? new UnsupportedBackendService(configuredMode, this.configStore.getDefaultPageSize())
        : configuredMode === 'gitlab'
          ? new GitLabBoardService(this.configStore, this.output, globalThis.fetch, inferGitLabProjectFromRepo, this.context)
        : configuredMode === 'demo'
          ? new DemoService(this.configStore)
          : configuredMode === 'jiraapi'
            ? new JiraApiService(this.context, this.configStore, this.output)
          : configuredMode === 'livefolder'
            ? new LiveFolderService(this.configStore)
          : configuredMode === 'userworkspace'
            ? new UserWorkspaceService(this.configStore, this.userWorkspaceStore)
            : new JiraService(this.context, this.configStore, this.output);
    if (this.activeService instanceof LiveFolderService) {
      this.externalCommentSub = this.activeService.onDidReceiveExternalComment(event =>
        this._onDidReceiveExternalComment.fire(event)
      );
    }
    return this.activeService;
  }

  private disposeActiveService(): void {
    this.externalCommentSub?.dispose();
    this.externalCommentSub = undefined;
    this.activeService?.dispose();
    this.activeService = undefined;
    this.activeMode = undefined;
  }
}
