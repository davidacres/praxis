import type {
  BackendMode,
  Board,
  BoardDetails,
  ConnectionCheck,
  FilterMetadata,
  IssueDetails,
  IssueSummary,
  PagedIssues,
  Project,
  WorkflowTransition
} from '../types';
import type { IssueTrackerService } from './issueTrackerService';

export function buildStubBackendMessage(mode: BackendMode): string {
  if (mode === 'demo') {
    return 'Demo mode is disabled. Start Praxis with --demo to load sample data.';
  }
  if (mode === 'github') {
    return 'GitHub project mode is not implemented yet. Current GitHub support is limited to setup metadata.';
  }
  if (mode === 'gitlab') {
    return 'GitLab project mode is not implemented yet. Current GitLab support is limited to setup metadata and repository automation helpers.';
  }
  if (mode === 'jiracloud') {
    return 'Jira is not configured. Add your Jira site URL and sign in with OAuth or an API token from the connection settings.';
  }
  return `${mode} backend mode is not supported in this build.`;
}

/**
 * Placeholder for a connection mode this host cannot serve yet. Reads return
 * empty (so a configured-but-unported connection contributes no boards and no
 * error noise to aggregate listings); every mutation throws a clear message.
 * Replaces the old silent fall-back to the demo backend, which made a broken
 * or unported connection indistinguishable from the demo data set.
 */
export class StubBackendService implements IssueTrackerService {
  public readonly mode: BackendMode;

  public constructor(private readonly unsupportedMode: BackendMode) {
    this.mode = unsupportedMode;
  }

  public getDefaultPageSize(): number {
    return 25;
  }

  public async reset(): Promise<void> {}

  public async checkConnection(): Promise<ConnectionCheck> {
    return {
      status: 'error',
      message: buildStubBackendMessage(this.unsupportedMode),
      toolCount: 0
    };
  }

  public async getProjects(): Promise<Project[]> {
    return [];
  }

  public async getIssues(): Promise<PagedIssues> {
    return { issues: [], hasMore: false };
  }

  public async getFilterMetadata(): Promise<FilterMetadata> {
    return { statuses: [], issueTypes: [] };
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

  public async getBoardDetails(): Promise<BoardDetails> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async createBoard(): Promise<Board> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async updateBoard(): Promise<Board> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async deleteBoard(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    throw new Error(`Cannot load ${issueKey}. ${buildStubBackendMessage(this.unsupportedMode)}`);
  }

  public async createIssue(): Promise<IssueDetails> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async updateIssue(): Promise<IssueDetails> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async deleteIssue(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async addComment(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async attachFile(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async downloadAttachment(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async getTransitions(): Promise<WorkflowTransition[]> {
    return [];
  }

  public async transitionIssue(): Promise<void> {
    throw new Error(buildStubBackendMessage(this.unsupportedMode));
  }

  public async getBrowseUrl(): Promise<string | undefined> {
    return undefined;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  public dispose(): void {}
}
