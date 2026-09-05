import type { GitHubBoardServiceOptions, GitHubConfigStore } from './githubConfigStore';
import type { LogSink } from '../host/logSink';
import type {
  Board,
  BoardColumn,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueComment,
  IssueAttachment,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  ParentItemQueryOptions,
  Project,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { sortIssuesByUpdated } from '../board/boardColumns';
import { GitHubApiService, type GitHubApiConfig, type GitHubIssue, type GitHubIssueComment } from './githubApiService';

const ISSUE_CREATION_DISABLED_ERROR =
  'Issue creation is disabled for this repository. Enable it on the connection to create GitHub issues.';

/**
 * Boards are synthesized from status labels named `status: <value>` already on
 * the repository — the same "works with zero setup" model as folder: a repo
 * with no such labels still renders a two-column board (Backlog / Closed), and
 * every `status: X` label found becomes its own column, sorted by its value.
 * There is deliberately no manual reordering or renaming in v1.
 */
const STATUS_LABEL_PATTERN = /^status:\s*(.+)$/i;

function extractStatusLabelValue(label: string): string | undefined {
  const match = STATUS_LABEL_PATTERN.exec(label.trim());
  return match ? match[1].trim() : undefined;
}

function parseGitHubIssueKey(issueKey: string): { issueNumber: number } {
  const match = /#(\d+)$/.exec(issueKey.trim());
  if (!match) {
    throw new Error(`Invalid GitHub issue key: ${issueKey}`);
  }
  return { issueNumber: Number(match[1]) };
}

function buildBoardColumns(statusLabels: string[]): BoardColumn[] {
  const columns: BoardColumn[] = [
    { id: 'backlog', name: 'Backlog', statusCategory: 'todo', issues: [] }
  ];
  for (const label of statusLabels) {
    columns.push({ id: `status:${label}`, name: label, issues: [] });
  }
  columns.push({ id: 'closed', name: 'Closed', statusCategory: 'done', issues: [] });
  return columns;
}

function resolveIssueColumn(issue: GitHubIssue, statusLabels: string[]): BoardColumn {
  if (issue.state.trim().toLowerCase() === 'closed') {
    return { id: 'closed', name: 'Closed', statusCategory: 'done', issues: [] };
  }

  const issueStatusValues = issue.labels
    .map(extractStatusLabelValue)
    .filter((value): value is string => Boolean(value));
  const matchedLabel = statusLabels.find(label =>
    issueStatusValues.some(value => value.toLowerCase() === label.toLowerCase())
  );
  if (matchedLabel) {
    return { id: `status:${matchedLabel}`, name: matchedLabel, issues: [] };
  }

  return { id: 'backlog', name: 'Backlog', statusCategory: 'todo', issues: [] };
}

function nonStatusLabels(issue: GitHubIssue): string[] {
  return issue.labels.filter(label => !extractStatusLabelValue(label));
}

function toIssueSummary(issue: GitHubIssue, config: GitHubApiConfig, column: BoardColumn): IssueSummary {
  const projectKey = `${config.owner}/${config.repo}`;
  return {
    id: String(issue.id),
    key: `${projectKey}#${issue.number}`,
    summary: issue.title,
    status: column.name,
    statusCategory: column.statusCategory,
    issueType: 'issue',
    projectKey,
    projectName: config.repo,
    assignee: issue.assignees.map(assignee => assignee.name ?? assignee.login).filter(Boolean).join(', ') || undefined,
    reporter: issue.authorLogin,
    created: issue.createdAt,
    updated: issue.updatedAt,
    browseUrl: issue.htmlUrl,
    description: issue.body,
    raw: issue.raw
  };
}

function toIssueComments(comments: GitHubIssueComment[]): IssueComment[] {
  return comments.map(comment => ({
    id: comment.id,
    author: comment.author,
    body: comment.body,
    created: comment.createdAt,
    updated: comment.updatedAt,
    raw: comment.raw
  }));
}

function buildBoardIssues(issues: GitHubIssue[], config: GitHubApiConfig, statusLabels: string[]): IssueSummary[] {
  return issues.map(issue => toIssueSummary(issue, config, resolveIssueColumn(issue, statusLabels)));
}

function buildBoardTransitions(issue: GitHubIssue, statusLabels: string[]): WorkflowTransition[] {
  const currentColumn = resolveIssueColumn(issue, statusLabels);
  return buildBoardColumns(statusLabels)
    .filter(column => column.id !== currentColumn.id)
    .map(column => ({
      id: `github:${column.id}`,
      name: `Move to ${column.name}`,
      toStatus: column.name,
      raw: column
    }));
}

function getUnsupportedGitHubIssueEditFields(input: UpdateIssueInput): string[] {
  const unsupported: string[] = [];
  if (Object.hasOwn(input, 'parentKey')) {
    unsupported.push('parentKey');
  }
  if (typeof input.priority === 'string') {
    unsupported.push('priority');
  }
  if (typeof input.severity === 'string') {
    unsupported.push('severity');
  }
  if (typeof input.reportedBy === 'string') {
    unsupported.push('reportedBy');
  }
  if (typeof input.model === 'string') {
    unsupported.push('model');
  }
  if (typeof input.issueType === 'string') {
    unsupported.push('issueType');
  }
  if (typeof input.ideaTranscript === 'string') {
    unsupported.push('ideaTranscript');
  }
  return unsupported;
}

export class GitHubBoardService implements IssueTrackerService {
  public readonly mode = 'github' as const;
  private cachedApiConfig?: GitHubApiConfig;
  private cachedStatusLabels?: string[];

  public constructor(
    private readonly configStore: GitHubConfigStore,
    private readonly output: LogSink,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly options?: GitHubBoardServiceOptions
  ) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.cachedApiConfig = undefined;
    this.cachedStatusLabels = undefined;
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    const client = await this.getClient();
    const repo = await client.getRepo();
    const statusLabels = await this.ensureStatusLabels(client);
    return {
      status: 'ok',
      message:
        statusLabels.length === 0
          ? `Connected to GitHub repository ${repo.fullName}. No "status: …" labels found — the board shows Backlog and Closed only.`
          : `Connected to GitHub repository ${repo.fullName}. ${statusLabels.length} status column(s) found: ${statusLabels.join(', ')}.`,
      toolCount: 2,
      projectCount: 1,
      serverName: this.getConfiguredBaseUrl()
    };
  }

  public async getProjects(): Promise<Project[]> {
    const config = await this.getApiConfig();
    return [{ key: `${config.owner}/${config.repo}`, name: `${config.owner}/${config.repo}` }];
  }

  /**
   * GitHub's REST API has no notion of our status/type/parent filters, so
   * (mirroring GitLab) the repository's full issue set is fetched once and
   * filtered/paged in memory. Requires `filters.boardId` — there is exactly
   * one board per connection, so this only guards against an unloaded board.
   */
  public async getIssues(filters: IssueFilters, startAt: number, pageSize: number): Promise<PagedIssues> {
    if (!filters.boardId) {
      return { issues: [], total: 0, hasMore: false };
    }

    const client = await this.getClient();
    const config = await this.getApiConfig();
    const [issues, statusLabels] = await Promise.all([client.listIssues(), this.ensureStatusLabels(client)]);
    const boardIssues = buildBoardIssues(issues, config, statusLabels);

    const query = filters.searchText.trim().toLowerCase();
    const matching = sortIssuesByUpdated(
      boardIssues.filter(issue => {
        if (filters.statuses.length > 0 && !filters.statuses.includes(issue.status)) {
          return false;
        }
        if (filters.issueTypes.length > 0 && !filters.issueTypes.includes(issue.issueType)) {
          return false;
        }
        if (!query) {
          return true;
        }
        const haystack = `${issue.key} ${issue.summary} ${issue.description ?? ''}`.toLowerCase();
        return haystack.includes(query);
      })
    );

    return {
      issues: matching.slice(startAt, startAt + pageSize),
      total: matching.length,
      hasMore: startAt + pageSize < matching.length
    };
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    const metadataFilters: IssueFilters = { ...filters, statuses: [], issueTypes: [] };
    const page = await this.getIssues(metadataFilters, 0, Number.MAX_SAFE_INTEGER);
    return {
      statuses: [...new Set(page.issues.map(issue => issue.status))].sort((a, b) => a.localeCompare(b)),
      issueTypes: [...new Set(page.issues.map(issue => issue.issueType))].sort((a, b) => a.localeCompare(b))
    };
  }

  public async getParentItems(
    _filters: IssueFilters,
    _searchText?: string,
    _options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    return [];
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const config = await this.getApiConfig();
    const board: Board = {
      id: `github:${config.owner}/${config.repo}`,
      name: `${config.owner}/${config.repo}`,
      type: 'issue-board',
      projectKey: `${config.owner}/${config.repo}`,
      projectName: config.repo,
      locationName: this.getConfiguredBaseUrl()
    };
    return this.matchesBoardFilters(board, filters) ? [board] : [];
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const client = await this.getClient();
    const config = await this.getApiConfig();
    const [issues, statusLabels] = await Promise.all([client.listIssues(), this.ensureStatusLabels(client)]);
    const columns = buildBoardColumns(statusLabels);
    const boardIssues = buildBoardIssues(issues, config, statusLabels);

    const issuesByStatus = new Map<string, IssueSummary[]>();
    for (const issue of boardIssues) {
      const list = issuesByStatus.get(issue.status) ?? [];
      list.push(issue);
      issuesByStatus.set(issue.status, list);
    }

    return {
      board: { ...board, projectKey: config.owner + '/' + config.repo, projectName: config.repo },
      columns: columns.map(column => ({ ...column, issues: issuesByStatus.get(column.name) ?? [] })),
      issues: boardIssues,
      columnStatusOrder: columns.map(column => column.name)
    };
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('GitHub mode does not support creating boards. The connection\'s repository is the board.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('GitHub mode does not support updating boards. The connection\'s repository is the board.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('GitHub mode does not support deleting boards. Remove the connection instead.');
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const { issueNumber } = parseGitHubIssueKey(issueKey);
    const client = await this.getClient();
    const config = await this.getApiConfig();
    const [issue, comments, statusLabels] = await Promise.all([
      client.getIssue(issueNumber),
      client.listIssueComments(issueNumber),
      this.ensureStatusLabels(client)
    ]);
    const column = resolveIssueColumn(issue, statusLabels);

    return {
      ...toIssueSummary(issue, config, column),
      comments: toIssueComments(comments),
      transitions: buildBoardTransitions(issue, statusLabels)
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    if (!this.configStore.getGitHubAllowIssueCreation()) {
      throw new Error(ISSUE_CREATION_DISABLED_ERROR);
    }

    const summary = input.summary.trim();
    if (!summary) {
      throw new Error('Summary cannot be empty.');
    }

    const client = await this.getClient();
    const config = await this.getApiConfig();
    const created = await client.createIssue({
      title: summary,
      body: input.description?.trim() || undefined
    });
    return this.getIssue(`${config.owner}/${config.repo}#${created.number}`);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const unsupportedFields = getUnsupportedGitHubIssueEditFields(input);
    if (unsupportedFields.length > 0) {
      throw new Error(`GitHub issue editing currently supports summary, description, and assignee only. Unsupported fields: ${unsupportedFields.join(', ')}.`);
    }

    const { issueNumber } = parseGitHubIssueKey(issueKey);
    const client = await this.getClient();
    await client.updateIssue(issueNumber, {
      title: input.summary?.trim(),
      body: typeof input.description === 'string' ? input.description : undefined,
      assignees: Object.hasOwn(input, 'assignee') ? this.parseAssigneeLogins(input.assignee) : undefined
    });
    return this.getIssue(issueKey);
  }

  public async deleteIssue(_issueKey: string): Promise<void> {
    throw new Error('GitHub mode does not support deleting issues. Close the issue instead.');
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error('Comment cannot be empty.');
    }
    const { issueNumber } = parseGitHubIssueKey(issueKey);
    const client = await this.getClient();
    await client.addIssueComment(issueNumber, trimmed);
  }

  public async attachFile(_issueKey: string, _filePath: string, _fileName?: string): Promise<void> {
    throw new Error('GitHub mode does not support attachments. Add files as links in the issue description or a comment instead.');
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error('GitHub mode does not support attachments. Add files as links in the issue description or a comment instead.');
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    const { issueNumber } = parseGitHubIssueKey(issueKey);
    const client = await this.getClient();
    const [issue, statusLabels] = await Promise.all([client.getIssue(issueNumber), this.ensureStatusLabels(client)]);
    return buildBoardTransitions(issue, statusLabels);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const targetColumnId = transitionId.replace(/^github:/, '').trim();
    const { issueNumber } = parseGitHubIssueKey(issueKey);
    const client = await this.getClient();
    const [issue, statusLabels] = await Promise.all([client.getIssue(issueNumber), this.ensureStatusLabels(client)]);
    const targetColumn = buildBoardColumns(statusLabels).find(column => column.id === targetColumnId);
    if (!targetColumn) {
      throw new Error(`Unknown GitHub board column: ${targetColumnId}`);
    }

    const targetStatusValue = statusLabels.find(label => label.toLowerCase() === targetColumn.name.toLowerCase());
    const nextLabels = [...nonStatusLabels(issue), ...(targetStatusValue ? [`status: ${targetStatusValue}`] : [])];
    await client.updateIssue(issueNumber, {
      state: targetColumn.id === 'closed' ? 'closed' : 'open',
      labels: nextLabels
    });
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    const client = await this.getClient();
    const currentUser = await client.getCurrentUser();
    return currentUser.login?.trim() || undefined;
  }

  public dispose(): void {
    return;
  }

  private parseAssigneeLogins(assignee: UpdateIssueInput['assignee']): string[] {
    if (assignee === null || assignee === undefined) {
      return [];
    }
    return assignee
      .split(',')
      .map(value => value.trim())
      .filter(value => value.length > 0);
  }

  private async ensureStatusLabels(client: GitHubApiService): Promise<string[]> {
    if (this.cachedStatusLabels) {
      return this.cachedStatusLabels;
    }
    const labels = await client.listLabels();
    const statusValues = [...new Set(
      labels.map(label => extractStatusLabelValue(label.name)).filter((value): value is string => Boolean(value))
    )].sort((a, b) => a.localeCompare(b));
    this.cachedStatusLabels = statusValues;
    return statusValues;
  }

  private async getClient(): Promise<GitHubApiService> {
    const config = await this.getApiConfig();
    return new GitHubApiService(config, this.fetchImpl);
  }

  private async getApiConfig(): Promise<GitHubApiConfig> {
    if (this.cachedApiConfig) {
      return this.cachedApiConfig;
    }

    const token = (this.options?.getApiKeyFromSecrets
      ? await this.options.getApiKeyFromSecrets()
      : this.configStore.getGitHubApiKey().trim()
    ) || process.env.GITHUB_TOKEN?.trim() || '';
    if (!token) {
      throw new Error('No GitHub personal access token is configured.');
    }

    const owner = this.configStore.getGitHubOwner().trim();
    const repo = this.configStore.getGitHubRepo().trim();
    if (!owner || !repo) {
      throw new Error('Configure a GitHub repository owner and name for this connection.');
    }

    this.cachedApiConfig = {
      baseUrl: this.getConfiguredBaseUrl(),
      owner,
      repo,
      token
    };
    this.output.appendLine(`[github] Using GitHub repository ${owner}/${repo}.`);
    return this.cachedApiConfig;
  }

  private getConfiguredBaseUrl(): string {
    return (this.configStore.getGitHubApiUrl().trim() || 'https://api.github.com').replace(/\/+$/, '');
  }

  private matchesBoardFilters(board: Board, filters: BoardFilters): boolean {
    if (filters.types.length > 0 && !filters.types.includes(board.type)) {
      return false;
    }
    if (filters.projectKeys.length > 0) {
      const boardProjectKey = board.projectKey?.trim();
      if (!boardProjectKey || !filters.projectKeys.includes(boardProjectKey)) {
        return false;
      }
    }
    const searchText = filters.searchText.trim().toLowerCase();
    if (!searchText) {
      return true;
    }
    const target = `${board.name} ${board.projectKey ?? ''} ${board.projectName ?? ''} ${board.locationName ?? ''}`.toLowerCase();
    return target.includes(searchText);
  }
}
