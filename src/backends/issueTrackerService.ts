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

export interface IssueTrackerService extends vscode.Disposable {
  readonly mode: BackendMode;

  getDefaultPageSize(): number;
  reset(): Promise<void>;
  checkConnection(): Promise<JiraConnectionCheck>;
  getProjects(forceRefresh?: boolean): Promise<JiraProject[]>;
  getIssues(filters: JiraFilters, startAt: number, pageSize: number): Promise<PagedIssues>;
  getFilterMetadata(filters: JiraFilters): Promise<FilterMetadata>;
  getEpics(filters: JiraFilters, searchText?: string): Promise<JiraIssueSummary[]>;
  supportsBoards(): Promise<boolean>;
  getBoards(filters: JiraBoardFilters): Promise<JiraBoard[]>;
  getBoardDetails(board: JiraBoard): Promise<JiraBoardDetails>;
  getIssue(issueKey: string): Promise<JiraIssueDetails>;
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  getBrowseUrl(issue: JiraIssueSummary): Promise<string | undefined>;
}
