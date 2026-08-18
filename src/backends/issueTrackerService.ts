import * as vscode from 'vscode';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
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
  CreateBoardInput,
  UpdateBoardInput,
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
  getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]>;
  supportsBoards(): Promise<boolean>;
  getBoards(filters: BoardFilters): Promise<Board[]>;
  getBoardDetails(board: Board): Promise<BoardDetails>;
  createBoard(input: CreateBoardInput): Promise<Board>;
  updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board>;
  deleteBoard(boardId: string): Promise<void>;
  getIssue(issueKey: string): Promise<IssueDetails>;
  createIssue(input: CreateIssueInput): Promise<IssueDetails>;
  updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails>;
  deleteIssue(issueKey: string): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  attachFile(issueKey: string, filePath: string, fileName?: string): Promise<void>;
  downloadAttachment(issueKey: string, attachment: IssueAttachment, targetFilePath: string): Promise<void>;
  getTransitions(issueKey: string): Promise<WorkflowTransition[]>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  getBrowseUrl(issue: IssueSummary): Promise<string | undefined>;

  /** Display name to assign when using "Assign to me"; undefined if not known for this backend. */
  getSelfAssigneeLabel(): Promise<string | undefined>;

  /** Fetch sub-tasks for a parent issue. Only supported for the Jira MCP backend. */
  getSubTasks?(parentKey: string): Promise<SubTaskSummary[]>;

  /** Create sub-tasks linked to a parent issue. Only supported for the Jira MCP backend. */
  createSubTasks?(
    parentKey: string,
    projectKey: string,
    subTasks: Array<{ summary: string; description: string; issueType?: string }>
  ): Promise<string[]>;
}
