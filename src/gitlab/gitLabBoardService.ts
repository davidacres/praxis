import * as vscode from 'vscode';
import { AppConfigStore } from '../config/jiraConfig';
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
import {
  GitLabApiService,
  inferGitLabProjectFromRepo,
  type GitLabApiConfig,
  type GitLabBoard,
  type GitLabBoardList,
  type GitLabIssueComment,
  type GitLabIssue,
  type GitLabProject,
  type GitLabProjectRemote,
  type GitLabUser
} from './gitLabApiService';

interface GitLabBoardContext {
  projectRef: string | number;
  board: GitLabBoard;
  lists: GitLabBoardList[];
}

interface GitLabSelectedBoardRef {
  projectPath: string;
  boardId: number;
}

function buildUnsupportedGitLabIssueMessage(): string {
  return 'GitLab issue access is not implemented yet. GitLab board listing is available.';
}

function buildGitLabSelectedBoardRef(projectPath: string, boardId: number): string {
  return `${projectPath.trim()}::${boardId}`;
}

function parseGitLabSelectedBoardRef(value: string): GitLabSelectedBoardRef | undefined {
  const match = /^(.*)::(\d+)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const projectPath = match[1].trim();
  const boardId = Number(match[2]);
  if (!projectPath || !Number.isInteger(boardId)) {
    return undefined;
  }

  return {
    projectPath,
    boardId
  };
}

function parseGitLabIssueKey(issueKey: string): { projectRef: string; issueIid: number } {
  const match = /^(?<project>.+)#(?<iid>\d+)$/.exec(issueKey.trim());
  if (!match?.groups) {
    throw new Error(`Invalid GitLab issue key: ${issueKey}`);
  }

  return {
    projectRef: match.groups.project,
    issueIid: Number(match.groups.iid)
  };
}

function buildBoardColumns(board: GitLabBoard, lists: GitLabBoardList[]): BoardColumn[] {
  const columns: BoardColumn[] = [];

  if (!board.hideBacklogList) {
    columns.push({
      id: `${board.id}:backlog`,
      name: 'Backlog',
      statusCategory: 'todo',
      issues: []
    });
  }

  for (const list of lists) {
    columns.push({
      id: `${board.id}:list:${list.id}`,
      name: list.title,
      issues: []
    });
  }

  if (!board.hideClosedList) {
    columns.push({
      id: `${board.id}:closed`,
      name: 'Closed',
      statusCategory: 'done',
      issues: []
    });
  }

  return columns;
}

function normalizedGitLabValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function matchesBoardList(issue: GitLabIssue, list: GitLabBoardList): boolean {
  if (list.kind === 'label' && list.labelName) {
    return issue.labels.some(label => normalizedGitLabValue(label) === normalizedGitLabValue(list.labelName));
  }

  if (list.kind === 'assignee' && list.assigneeUsername) {
    return issue.assignees.some(assignee => normalizedGitLabValue(assignee.username) === normalizedGitLabValue(list.assigneeUsername));
  }

  if (list.kind === 'milestone' && list.milestoneTitle) {
    return normalizedGitLabValue(issue.milestoneTitle) === normalizedGitLabValue(list.milestoneTitle);
  }

  if (list.kind === 'iteration' && list.iterationTitle) {
    return normalizedGitLabValue(issue.iterationTitle) === normalizedGitLabValue(list.iterationTitle);
  }

  return false;
}

function resolveIssueColumn(issue: GitLabIssue, board: GitLabBoard, lists: GitLabBoardList[]): BoardColumn | undefined {
  if (issue.state.trim().toLowerCase() === 'closed') {
    return board.hideClosedList ? undefined : {
      id: `${board.id}:closed`,
      name: 'Closed',
      statusCategory: 'done',
      issues: []
    };
  }

  const matchingList = lists.find(list => matchesBoardList(issue, list));
  if (matchingList) {
    return {
      id: `${board.id}:list:${matchingList.id}`,
      name: matchingList.title,
      issues: []
    };
  }

  if (board.hideBacklogList) {
    return undefined;
  }

  return {
    id: `${board.id}:backlog`,
    name: 'Backlog',
    statusCategory: 'todo',
    issues: []
  };
}

function toIssueSummary(issue: GitLabIssue, project: GitLabProject, status: string, statusCategory?: string): IssueSummary {
  return {
    id: String(issue.id),
    key: issue.references?.full ?? `${project.pathWithNamespace}#${issue.iid}`,
    summary: issue.title,
    status,
    statusCategory,
    issueType: 'issue',
    projectKey: project.pathWithNamespace,
    projectName: project.name,
    assignee: issue.assignees.map(assignee => assignee.name ?? assignee.username).filter(Boolean).join(', ') || undefined,
    reporter: issue.authorName,
    created: issue.createdAt,
    updated: issue.updatedAt,
    browseUrl: issue.webUrl,
    description: issue.description,
    raw: issue.raw
  };
}

function toIssueComments(comments: GitLabIssueComment[]): IssueComment[] {
  return comments.map(comment => ({
    id: comment.id,
    author: comment.author,
    body: comment.body,
    created: comment.createdAt,
    updated: comment.updatedAt,
    raw: comment.raw
  }));
}

function buildBoardTransitions(
  issue: GitLabIssue,
  context: GitLabBoardContext
): WorkflowTransition[] {
  const currentColumn = resolveIssueColumn(issue, context.board, context.lists)?.name;
  return buildBoardColumns(context.board, context.lists)
    .filter(column => column.name !== currentColumn)
    .map(column => ({
      id: `gitlab:${column.name}`,
      name: `Move to ${column.name}`,
      toStatus: column.name,
      raw: column
    }));
}

function buildGitLabTransitionUpdate(
  issue: GitLabIssue,
  targetColumn: BoardColumn,
  targetList: GitLabBoardList | undefined,
  context: GitLabBoardContext
): {
  stateEvent?: 'close' | 'reopen';
  addLabels?: string[];
  removeLabels?: string[];
  assigneeIds?: number[];
  milestoneId?: number;
  iterationId?: number;
} {
  const update: {
    stateEvent?: 'close' | 'reopen';
    addLabels?: string[];
    removeLabels?: string[];
    assigneeIds?: number[];
    milestoneId?: number;
    iterationId?: number;
  } = {};
  const isBacklogTarget = targetColumn.name === 'Backlog';

  if (targetColumn.name === 'Closed') {
    update.stateEvent = 'close';
  } else if (issue.state.trim().toLowerCase() === 'closed') {
    update.stateEvent = 'reopen';
  }

  applyLabelTransitionUpdate(update, issue, targetList, isBacklogTarget, context);

  if (targetList?.kind === 'assignee') {
    update.assigneeIds = typeof targetList.assigneeId === 'number' ? [targetList.assigneeId] : [];
  } else if (isBacklogTarget && context.lists.some(list => list.kind === 'assignee')) {
    update.assigneeIds = [];
  }

  if (targetList?.kind === 'milestone') {
    update.milestoneId = targetList.milestoneId ?? 0;
  } else if (isBacklogTarget && context.lists.some(list => list.kind === 'milestone')) {
    update.milestoneId = 0;
  }

  if (targetList?.kind === 'iteration') {
    update.iterationId = targetList.iterationId ?? 0;
  } else if (isBacklogTarget && context.lists.some(list => list.kind === 'iteration')) {
    update.iterationId = 0;
  }

  return update;
}

function normalizedGitLabUserLabels(user: Pick<GitLabUser, 'username' | 'name'>): string[] {
  return [user.username, user.name]
    .map(value => normalizedGitLabValue(value))
    .filter((value, index, labels) => value.length > 0 && labels.indexOf(value) === index);
}

function pickMatchingGitLabUser(searchText: string, users: GitLabUser[]): GitLabUser | undefined {
  const normalizedSearch = normalizedGitLabValue(searchText);
  const exactMatches = users.filter(user => normalizedGitLabUserLabels(user).includes(normalizedSearch));
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    const usernameMatches = exactMatches.filter(user => normalizedGitLabValue(user.username) === normalizedSearch);
    if (usernameMatches.length === 1) {
      return usernameMatches[0];
    }
  }

  return undefined;
}

function applyLabelTransitionUpdate(
  update: {
    addLabels?: string[];
    removeLabels?: string[];
  },
  issue: GitLabIssue,
  targetList: GitLabBoardList | undefined,
  isBacklogTarget: boolean,
  context: GitLabBoardContext
): void {
  const removableBoardLabels = context.lists
    .filter(list => list.kind === 'label' && list.labelName)
    .map(list => list.labelName)
    .filter((label): label is string => Boolean(label))
    .filter(label => issue.labels.some(issueLabel => normalizedGitLabValue(issueLabel) === normalizedGitLabValue(label)));

  if (targetList?.kind === 'label' && targetList.labelName) {
    update.removeLabels = removableBoardLabels.filter(label => normalizedGitLabValue(label) !== normalizedGitLabValue(targetList.labelName));
    if (!issue.labels.some(label => normalizedGitLabValue(label) === normalizedGitLabValue(targetList.labelName))) {
      update.addLabels = [targetList.labelName];
    }
    return;
  }

  if (isBacklogTarget && removableBoardLabels.length > 0) {
    update.removeLabels = removableBoardLabels;
  }
}

function getUnsupportedGitLabIssueEditFields(input: UpdateIssueInput): string[] {
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

function buildBoardIssues(board: GitLabBoard, lists: GitLabBoardList[], issues: GitLabIssue[]): IssueSummary[] {
  return issues
    .map(issue => {
      const column = resolveIssueColumn(issue, board, lists);
      if (!column) {
        return undefined;
      }

      return toIssueSummary(issue, board.project, column.name, column.statusCategory);
    })
    .filter((issue): issue is IssueSummary => Boolean(issue));
}

export class GitLabBoardService implements IssueTrackerService {
  public readonly mode = 'gitlab' as const;
  private cachedApiConfig?: GitLabApiConfig;
  private readonly boardContextByIssueKey = new Map<string, GitLabBoardContext>();

  public constructor(
    private readonly configStore: AppConfigStore,
    private readonly output: vscode.OutputChannel,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly inferProjectRemote: (repoPath: string) => Promise<GitLabProjectRemote> = inferGitLabProjectFromRepo,
    private readonly context?: vscode.ExtensionContext
  ) {}

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.cachedApiConfig = undefined;
    this.boardContextByIssueKey.clear();
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    const client = await this.getClient();
    const projects = await this.resolveProjects();
    const boards = await this.listBoardsForProjects(client, projects);
    if (projects.length !== 1) {
      return {
        status: 'ok',
        message:
          boards.length === 0
            ? `Connected to GitLab. ${projects.length} accessible project(s) found, but no boards are available.`
            : `Connected to GitLab. ${boards.length} board(s) found across ${projects.length} accessible project(s).`,
        toolCount: 3,
        projectCount: projects.length,
        serverName: this.getConfiguredBaseUrl()
      };
    }

    const [project] = projects;
    return {
      status: 'ok',
      message:
        boards.length === 0
          ? `Connected to GitLab project ${project.pathWithNamespace}, but no boards are available.`
          : `Connected to GitLab project ${project.pathWithNamespace}. ${boards.length} board(s) found.`,
      toolCount: 3,
      projectCount: 1,
      serverName: this.getConfiguredBaseUrl()
    };
  }

  public async getProjects(): Promise<Project[]> {
    const projects = await this.resolveProjects();
    return projects.map(project => ({
      id: String(project.id),
      key: project.pathWithNamespace,
      name: project.name
    }));
  }

  public async getIssues(_filters: IssueFilters, _startAt: number, _pageSize: number): Promise<PagedIssues> {
    return {
      issues: [],
      total: 0,
      hasMore: false
    };
  }

  public async getFilterMetadata(_filters: IssueFilters): Promise<FilterMetadata> {
    return {
      statuses: [],
      issueTypes: []
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
    const client = await this.getClient();
    const boards = await this.listVisibleBoards(client, filters.projectKeys);
    return boards
      .map(board => ({
        id: `gitlab:${board.project.id}:${board.id}`,
        name: board.name,
        type: 'issue-board',
        projectKey: board.project.pathWithNamespace,
        projectName: board.project.name,
        locationName: this.getConfiguredBaseUrl(),
        raw: board
      }))
      .filter(board => this.matchesBoardFilters(board, filters));
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const { projectRef, boardId } = this.parseBoardReference(board);
    const client = await this.getClient();
    const [gitlabBoard, lists] = await Promise.all([
      client.getBoard(boardId, projectRef),
      client.listBoardLists(boardId, projectRef)
    ]);
    const columns = buildBoardColumns(gitlabBoard, lists);
    const issues = buildBoardIssues(
      gitlabBoard,
      lists,
      await client.listIssues(projectRef, {
        state: 'all',
        labels: gitlabBoard.labels,
        assigneeUsername: gitlabBoard.assigneeUsername,
        milestoneTitle: gitlabBoard.milestoneTitle,
        weight: gitlabBoard.weight
      })
    );
    for (const issue of issues) {
      this.boardContextByIssueKey.set(issue.key, {
        projectRef,
        board: gitlabBoard,
        lists
      });
    }

    const issuesByStatus = new Map<string, IssueSummary[]>();
    for (const issue of issues) {
      const list = issuesByStatus.get(issue.status) ?? [];
      list.push(issue);
      issuesByStatus.set(issue.status, list);
    }

    return {
      board: {
        ...board,
        name: gitlabBoard.name,
        projectKey: gitlabBoard.project.pathWithNamespace,
        projectName: gitlabBoard.project.name,
        locationName: this.getConfiguredBaseUrl(),
        raw: gitlabBoard
      },
      columns: columns.map(column => ({
        ...column,
        issues: issuesByStatus.get(column.name) ?? []
      })),
      issues,
      columnStatusOrder: columns.map(column => column.name)
    };
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Creating GitLab boards is not implemented yet.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('Updating GitLab boards is not implemented yet.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Deleting GitLab boards is not implemented yet.');
  }

  public async getIssue(_issueKey: string): Promise<IssueDetails> {
    const { projectRef, issueIid } = parseGitLabIssueKey(_issueKey);
    const client = await this.getClient();
    const [issue, comments] = await Promise.all([
      client.getIssue(issueIid, projectRef),
      client.listIssueComments(issueIid, projectRef)
    ]);
    const project = await client.getProject(projectRef);
    const context = this.boardContextByIssueKey.get(_issueKey);
    const column = context ? resolveIssueColumn(issue, context.board, context.lists) : undefined;

    return {
      ...toIssueSummary(
        issue,
        project,
        column?.name ?? (issue.state.trim().toLowerCase() === 'closed' ? 'Closed' : 'Open'),
        column?.statusCategory ?? (issue.state.trim().toLowerCase() === 'closed' ? 'done' : undefined)
      ),
      comments: toIssueComments(comments),
      transitions: context ? buildBoardTransitions(issue, context) : []
    };
  }

  public async createIssue(_input: CreateIssueInput): Promise<IssueDetails> {
    throw new Error(buildUnsupportedGitLabIssueMessage());
  }

  public async updateIssue(_issueKey: string, _input: UpdateIssueInput): Promise<IssueDetails> {
    const unsupportedFields = getUnsupportedGitLabIssueEditFields(_input);
    if (unsupportedFields.length > 0) {
      throw new Error(`GitLab issue editing currently supports summary, description, and assignee only. Unsupported fields: ${unsupportedFields.join(', ')}.`);
    }

    const { projectRef, issueIid } = parseGitLabIssueKey(_issueKey);
    const client = await this.getClient();
    const assigneeIds = Object.hasOwn(_input, 'assignee')
      ? await this.resolveAssigneeIds(client, _input.assignee)
      : undefined;
    await client.updateIssue(
      issueIid,
      {
        title: _input.summary?.trim(),
        description: typeof _input.description === 'string' ? _input.description : undefined,
        assigneeIds
      },
      projectRef
    );
    return this.getIssue(_issueKey);
  }

  public async deleteIssue(_issueKey: string): Promise<void> {
    throw new Error(buildUnsupportedGitLabIssueMessage());
  }

  public async addComment(_issueKey: string, _body: string): Promise<void> {
    const trimmed = _body.trim();
    if (!trimmed) {
      throw new Error('Comment cannot be empty.');
    }

    const { projectRef, issueIid } = parseGitLabIssueKey(_issueKey);
    const client = await this.getClient();
    await client.addIssueComment(issueIid, trimmed, projectRef);
  }

  public async attachFile(_issueKey: string, _filePath: string, _fileName?: string): Promise<void> {
    throw new Error(buildUnsupportedGitLabIssueMessage());
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error(buildUnsupportedGitLabIssueMessage());
  }

  public async getTransitions(_issueKey: string): Promise<WorkflowTransition[]> {
    const context = this.boardContextByIssueKey.get(_issueKey);
    if (!context) {
      return [];
    }

    const { projectRef, issueIid } = parseGitLabIssueKey(_issueKey);
    const client = await this.getClient();
    const issue = await client.getIssue(issueIid, projectRef);
    return buildBoardTransitions(issue, context);
  }

  public async transitionIssue(_issueKey: string, _transitionId: string): Promise<void> {
    const context = this.boardContextByIssueKey.get(_issueKey);
    if (!context) {
      throw new Error('Load the GitLab board before moving cards so board column transitions are available.');
    }

    const targetStatus = _transitionId.replace(/^gitlab:/, '').trim();
    const { projectRef, issueIid } = parseGitLabIssueKey(_issueKey);
    const client = await this.getClient();
    const issue = await client.getIssue(issueIid, projectRef);
    const targetColumn = buildBoardColumns(context.board, context.lists).find(column => column.name === targetStatus);
    if (!targetColumn) {
      throw new Error(`Unknown GitLab board column: ${targetStatus}`);
    }

    const targetList = context.lists.find(list => list.title === targetColumn.name);
    await client.updateIssue(issueIid, buildGitLabTransitionUpdate(issue, targetColumn, targetList, context), projectRef);
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    const client = await this.getClient();
    const currentUser = await client.getCurrentUser();
    return currentUser.username?.trim() || currentUser.name?.trim() || undefined;
  }

  public dispose(): void {
    return;
  }

  private async getClient(): Promise<GitLabApiService> {
    const projectConfig = await this.getApiConfig();
    return new GitLabApiService(projectConfig, this.fetchImpl);
  }

  private async resolveAssigneeIds(
    client: GitLabApiService,
    assignee: UpdateIssueInput['assignee']
  ): Promise<number[]> {
    if (assignee === null) {
      return [];
    }

    const requestedAssignees = (assignee ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(value => value.length > 0);
    if (requestedAssignees.length === 0) {
      return [];
    }

    const resolvedIds: number[] = [];
    for (const requestedAssignee of requestedAssignees) {
      resolvedIds.push(await this.resolveAssigneeId(client, requestedAssignee));
    }

    return resolvedIds;
  }

  private async resolveAssigneeId(client: GitLabApiService, requestedAssignee: string): Promise<number> {
    const matchingUser = pickMatchingGitLabUser(requestedAssignee, await client.findUsers(requestedAssignee));
    if (matchingUser?.id) {
      return matchingUser.id;
    }

    throw new Error(`Could not resolve GitLab assignee "${requestedAssignee}" to a unique user.`);
  }

  private async getApiConfig(): Promise<GitLabApiConfig> {
    if (this.cachedApiConfig) {
      return this.cachedApiConfig;
    }

    if (this.configStore.getGitLabConnectionType() !== 'api') {
      throw new Error('GitLab boards currently support direct GitLab API connections only.');
    }
    const token = (this.context
      ? await this.configStore.getGitLabApiKeyFromSecrets(this.context)
      : this.configStore.getGitLabApiKey().trim()
    ) || process.env.GITLAB_TOKEN?.trim() || '';
    if (!token) {
      throw new Error('No GitLab API key is configured.');
    }

    const configuredProjectPath = this.configStore.getGitLabProjectPath().trim();
    const selectedBoardRefs = this.getSelectedBoardRefs();
    let projectPath = configuredProjectPath || selectedBoardRefs[0]?.projectPath || '';
    if (!projectPath && !this.configStore.getGitLabListAllAccessibleBoards()) {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspacePath) {
        throw new Error('Open the repository workspace to infer the GitLab project, or configure a GitLab project path.');
      }

      const inferredRemote = await this.inferProjectRemote(workspacePath);
      projectPath = inferredRemote.projectPath;
    }

    this.cachedApiConfig = {
      baseUrl: this.getConfiguredBaseUrl(),
      projectPath,
      token
    };
    this.output.appendLine(
      projectPath
        ? `[gitlab] Using GitLab boards project ${projectPath}.`
        : '[gitlab] Listing boards across accessible GitLab projects.'
    );
    return this.cachedApiConfig;
  }

  private getConfiguredBaseUrl(): string {
    return this.configStore.getGitLabUrl().trim().replace(/\/+$/, '');
  }

  private getSelectedBoardRefs(): GitLabSelectedBoardRef[] {
    return this.configStore
      .getGitLabSelectedBoardRefs()
      .map(parseGitLabSelectedBoardRef)
      .filter((value): value is GitLabSelectedBoardRef => Boolean(value));
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

  private async resolveProjects(projectKeys?: string[]): Promise<GitLabProject[]> {
    const client = await this.getClient();
    const configuredProjectPath = this.configStore.getGitLabProjectPath().trim();
    const selectedBoardRefs = this.getSelectedBoardRefs();
    if (configuredProjectPath && !this.configStore.getGitLabListAllAccessibleBoards()) {
      return [await client.getProject()];
    }

    if (selectedBoardRefs.length > 0 && !this.configStore.getGitLabListAllAccessibleBoards()) {
      const uniqueProjectPaths = [...new Set(selectedBoardRefs.map(ref => ref.projectPath))];
      const projects = await Promise.all(uniqueProjectPaths.map(projectPath => client.getProject(projectPath)));
      if (!projectKeys?.length) {
        return projects;
      }

      const selectedKeys = new Set(projectKeys.map(key => key.trim()).filter(Boolean));
      return projects.filter(project => selectedKeys.has(project.pathWithNamespace));
    }

    if (!configuredProjectPath && !this.configStore.getGitLabListAllAccessibleBoards()) {
      return [await client.getProject()];
    }

    const projects = await client.listAccessibleProjects();
    if (!projectKeys?.length) {
      return projects;
    }

    const selectedKeys = new Set(projectKeys.map(key => key.trim()).filter(Boolean));
    return projects.filter(project => selectedKeys.has(project.pathWithNamespace));
  }

  private async listBoardsForProjects(client: GitLabApiService, projects: GitLabProject[]): Promise<GitLabBoard[]> {
    const boardGroups = await Promise.all(projects.map(project => client.listBoards(project.id)));
    return boardGroups.flat();
  }

  private async listVisibleBoards(client: GitLabApiService, projectKeys?: string[]): Promise<GitLabBoard[]> {
    const selectedBoardRefs = this.getSelectedBoardRefs();
    if (selectedBoardRefs.length > 0 && !this.configStore.getGitLabListAllAccessibleBoards()) {
      const matchingRefs = !projectKeys?.length
        ? selectedBoardRefs
        : selectedBoardRefs.filter(ref => projectKeys.includes(ref.projectPath));
      const boardResults = await Promise.all(
        matchingRefs.map(async ref => client.getBoard(ref.boardId, ref.projectPath))
      );
      return boardResults;
    }

    const projects = await this.resolveProjects(projectKeys);
    return this.listBoardsForProjects(client, projects);
  }

  private parseBoardReference(board: Board): { projectRef: string | number; boardId: number } {
    const rawBoard = board.raw as { project?: { id?: number }; id?: number } | undefined;
    if (typeof rawBoard?.project?.id === 'number' && typeof rawBoard.id === 'number') {
      return {
        projectRef: rawBoard.project.id,
        boardId: rawBoard.id
      };
    }

    const match = /^gitlab:(\d+):(\d+)$/.exec(board.id.trim());
    if (match) {
      return {
        projectRef: Number(match[1]),
        boardId: Number(match[2])
      };
    }

    const legacyMatch = /^gitlab:(\d+)$/.exec(board.id.trim());
    if (legacyMatch) {
      const configuredProjectPath = this.configStore.getGitLabProjectPath().trim();
      if (!configuredProjectPath) {
        throw new Error(`Invalid GitLab board identifier: ${board.id}`);
      }

      return {
        projectRef: configuredProjectPath,
        boardId: Number(legacyMatch[1])
      };
    }

    throw new Error(`Invalid GitLab board identifier: ${board.id}`);
  }
}