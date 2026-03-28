import * as vscode from 'vscode';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateIssueInput,
  FilterMetadata,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  Project,
  UpdateIssueInput,
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
  createIssue(input: CreateIssueInput): Promise<IssueDetails>;
  updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails>;
  deleteIssue(issueKey: string): Promise<void>;
  getTransitions(issueKey: string): Promise<WorkflowTransition[]>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  getBrowseUrl(issue: IssueSummary): Promise<string | undefined>;
}
