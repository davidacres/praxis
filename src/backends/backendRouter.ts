import * as vscode from 'vscode';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  FilterMetadata,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  Project,
  WorkflowTransition
} from '../types';
import { AppConfigStore } from '../config/jiraConfig';
import { DemoService } from '../demo/demoService';
import { FilePlanService } from '../file/filePlanService';
import { JiraService } from '../jira/jiraService';
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
    searchText?: string
  ): Promise<IssueSummary[]> {
    return (await this.getService()).getParentItems(filters, searchText);
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

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    return (await this.getService()).getIssue(issueKey);
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
        : new JiraService(this.context, this.configStore, this.output);
    return this.activeService;
  }

  private disposeActiveService(): void {
    this.activeService?.dispose();
    this.activeService = undefined;
    this.activeMode = undefined;
  }
}
