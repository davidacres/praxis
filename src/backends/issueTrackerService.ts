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

export interface IssueTrackerService extends vscode.Disposable {
  readonly mode: BackendMode;

  getDefaultPageSize(): number;
  reset(): Promise<void>;
  checkConnection(): Promise<ConnectionCheck>;
  getProjects(forceRefresh?: boolean): Promise<Project[]>;
  getIssues(filters: IssueFilters, startAt: number, pageSize: number): Promise<PagedIssues>;
  getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata>;
  getParentItems(filters: IssueFilters, searchText?: string): Promise<IssueSummary[]>;
  supportsBoards(): Promise<boolean>;
  getBoards(filters: BoardFilters): Promise<Board[]>;
  getBoardDetails(board: Board): Promise<BoardDetails>;
  getIssue(issueKey: string): Promise<IssueDetails>;
  getTransitions(issueKey: string): Promise<WorkflowTransition[]>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  getBrowseUrl(issue: IssueSummary): Promise<string | undefined>;
}
