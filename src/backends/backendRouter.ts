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
  IssueDetails,
  IssueFilters,
  ParentItemQueryOptions,
  IssueSummary,
  PagedIssues,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import { AppConfigStore } from '../config/jiraConfig';
import { DemoService } from '../demo/demoService';
import { FilePlanService } from '../file/filePlanService';
import { JiraService } from '../jira/jiraService';
import { LiveFolderService } from '../livefolder/liveFolderService';
import type { IssueTrackerService } from './issueTrackerService';

export class BackendRouter implements IssueTrackerService {
  private activeMode?: BackendMode;
  private activeService?: IssueTrackerService;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly output: vscode.OutputChannel
  ) {}

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

  public dispose(): void {
    this.disposeActiveService();
  }

  private async getService(): Promise<IssueTrackerService> {
    const configuredMode = this.configStore.getEffectiveBackendMode();
    if (this.activeService && this.activeMode === configuredMode) {
      return this.activeService;
    }

    this.disposeActiveService();
    this.activeMode = configuredMode;
    this.activeService =
      configuredMode === 'demo'
        ? new DemoService(this.configStore)
        : configuredMode === 'file'
          ? new FilePlanService(this.configStore)
        : configuredMode === 'livefolder'
          ? new LiveFolderService(this.configStore)
        : new JiraService(this.context, this.configStore, this.output);
    return this.activeService;
  }

  private disposeActiveService(): void {
    this.activeService?.dispose();
    this.activeService = undefined;
    this.activeMode = undefined;
  }
}
