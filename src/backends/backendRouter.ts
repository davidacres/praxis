import * as vscode from 'vscode';
import type {
  BackendMode,
  FilterMetadata,
  JiraBoard,
  JiraBoardDetails,
  JiraBoardFilters,
  JiraConnectionCheck,
  JiraFilters,
  JiraIssueDetails,
  JiraIssueSummary,
  JiraProject,
  JiraTransition,
  PagedIssues
} from '../types';
import { JiraConfigStore } from '../config/jiraConfig';
import { DemoService } from '../demo/demoService';
import { JiraService } from '../jira/jiraService';
import type { IssueTrackerService } from './issueTrackerService';

export class BackendRouter implements IssueTrackerService {
  private activeMode?: BackendMode;
  private activeService?: IssueTrackerService;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: JiraConfigStore,
    private readonly output: vscode.OutputChannel
  ) {}

  public get mode(): BackendMode {
    return this.configStore.getBackendMode();
  }

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    const configuredMode = this.configStore.getBackendMode();
    if (!this.activeService) {
      return;
    }

    if (this.activeMode !== configuredMode) {
      this.disposeActiveService();
      return;
    }

    await this.activeService.reset();
  }

  public async checkConnection(): Promise<JiraConnectionCheck> {
    return (await this.getService()).checkConnection();
  }

  public async getProjects(forceRefresh = false): Promise<JiraProject[]> {
    return (await this.getService()).getProjects(forceRefresh);
  }

  public async getIssues(
    filters: JiraFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    return (await this.getService()).getIssues(filters, startAt, pageSize);
  }

  public async getFilterMetadata(filters: JiraFilters): Promise<FilterMetadata> {
    return (await this.getService()).getFilterMetadata(filters);
  }

  public async getEpics(filters: JiraFilters, searchText?: string): Promise<JiraIssueSummary[]> {
    return (await this.getService()).getEpics(filters, searchText);
  }

  public async supportsBoards(): Promise<boolean> {
    return (await this.getService()).supportsBoards();
  }

  public async getBoards(filters: JiraBoardFilters): Promise<JiraBoard[]> {
    return (await this.getService()).getBoards(filters);
  }

  public async getBoardDetails(board: JiraBoard): Promise<JiraBoardDetails> {
    return (await this.getService()).getBoardDetails(board);
  }

  public async getIssue(issueKey: string): Promise<JiraIssueDetails> {
    return (await this.getService()).getIssue(issueKey);
  }

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    return (await this.getService()).getTransitions(issueKey);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    return (await this.getService()).transitionIssue(issueKey, transitionId);
  }

  public async getBrowseUrl(issue: JiraIssueSummary): Promise<string | undefined> {
    return (await this.getService()).getBrowseUrl(issue);
  }

  public dispose(): void {
    this.disposeActiveService();
  }

  private async getService(): Promise<IssueTrackerService> {
    const configuredMode = this.configStore.getBackendMode();
    if (this.activeService && this.activeMode === configuredMode) {
      return this.activeService;
    }

    this.disposeActiveService();
    this.activeMode = configuredMode;
    this.activeService =
      configuredMode === 'demo'
        ? new DemoService(this.configStore)
        : new JiraService(this.context, this.configStore, this.output);
    return this.activeService;
  }

  private disposeActiveService(): void {
    this.activeService?.dispose();
    this.activeService = undefined;
    this.activeMode = undefined;
  }
}
