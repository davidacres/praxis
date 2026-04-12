import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import { buildIssuesJql, buildParentItemsJql, type ParentFieldMode } from './queryBuilder';
import { McpClientWrapper } from '../mcp/clientFactory';
import { resolveJiraCapabilities } from '../mcp/jiraCapabilityResolver';
import type {
  BackendMode,
  Board,
  BoardColumn,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  ConnectionConfig,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  JiraCapabilities,
  IssueComment,
  IssueDetails,
  IssueFilters,
  ParentIssueReference,
  ParentItemQueryOptions,
  IssueSummary,
  PagedIssues,
  Project,
  ToolDescriptor,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';
import {
  buildParentValidationMessage,
  getParentRule,
  isAllowedParentType,
  isParentIssueType,
  isSubtaskIssueType,
  normalizeIssueTypeLabel
} from '../issues/issueHierarchy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function deriveBrowseUrl(selfUrl: string | undefined, key: string): string | undefined {
  if (!selfUrl) {
    return undefined;
  }

  try {
    const url = new URL(selfUrl);
    return `${url.protocol}//${url.host}/browse/${key}`;
  } catch {
    return undefined;
  }
}

function extractDescription(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractDescription).filter((item): item is string => Boolean(item)).join(' ');
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const parts: string[] = [];
  if (typeof value.text === 'string') {
    parts.push(value.text);
  }

  if (Array.isArray(value.content)) {
    for (const child of value.content) {
      const text = extractDescription(child);
      if (text) {
        parts.push(text);
      }
    }
  }

  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 0 ? joined : undefined;
}

function normalizeProject(raw: unknown): Project | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const key = asString(raw.key);
  const name = asString(raw.name) ?? key;

  if (!key || !name) {
    return undefined;
  }

  return {
    id: asString(raw.id),
    key,
    name
  };
}

function normalizeBoard(raw: unknown): Board | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const location = isRecord(raw.location) ? raw.location : {};
  const project = isRecord(location.project) ? location.project : {};
  const id = asString(raw.id);
  const name = asString(raw.name);

  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    type: asString(raw.type) ?? 'unknown',
    projectKey: asString(location.projectKey) ?? asString(project.key),
    projectName: asString(location.projectName) ?? asString(project.name),
    locationName: asString(location.name),
    raw
  };
}

function normalizeTransition(raw: unknown): WorkflowTransition | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = asString(raw.id);
  const name = asString(raw.name);

  if (!id || !name) {
    return undefined;
  }

  return {
    id,
    name,
    toStatus:
      asString(raw.toStatus) ??
      (isRecord(raw.to) ? asString(raw.to.name) : undefined) ??
      asString(raw.status),
    raw
  };
}

function normalizeComment(raw: unknown): IssueComment | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const author = isRecord(raw.author) ? raw.author : {};
  const body = extractDescription(raw.body) ?? asString(raw.body);
  if (!body?.trim()) {
    return undefined;
  }

  return {
    id: asString(raw.id),
    author: asString(author.displayName) ?? asString(author.name),
    body: body.trim(),
    created: asString(raw.created),
    updated: asString(raw.updated),
    raw
  };
}

function normalizeParentIssue(raw: unknown): ParentIssueReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const key = asString(raw.key);
  if (!key) {
    return undefined;
  }

  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const issueType = isRecord(fields.issuetype)
    ? asString(fields.issuetype.name)
    : isRecord(fields.issueType)
      ? asString(fields.issueType.name)
      : asString(fields.issuetype) ?? asString(fields.issueType);

  return {
    key,
    summary: asString(fields.summary),
    issueType,
    description: extractDescription(fields.description)
  };
}

function normalizeIssue(raw: unknown): IssueSummary | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const project = isRecord(fields.project) ? fields.project : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const issueType = isRecord(fields.issuetype)
    ? fields.issuetype
    : isRecord(fields.issueType)
      ? fields.issueType
      : {};
  const parent = isRecord(fields.parent) ? fields.parent : {};
  const assignee = isRecord(fields.assignee) ? fields.assignee : {};
  const priority = isRecord(fields.priority) ? fields.priority : {};

  const key = asString(raw.key);
  const summary = asString(fields.summary) ?? '(No summary)';
  const projectKey = asString(project.key) ?? '';

  if (!key) {
    return undefined;
  }

  return {
    id: asString(raw.id),
    key,
    summary,
    status: asString(status.name) ?? asString(fields.status) ?? 'Unknown',
    statusCategory: isRecord(status.statusCategory)
      ? asString(status.statusCategory.name)
      : undefined,
    issueType: asString(issueType.name) ?? asString(fields.issuetype) ?? 'Issue',
    projectKey,
    projectName: asString(project.name),
    parentKey: asString(parent.key),
    parentIssue: normalizeParentIssue(parent),
    assignee: asString(assignee.displayName) ?? asString(assignee.name),
    priority: asString(priority.name) ?? asString(fields.priority),
    created: asString(fields.created) ?? asString(raw.created),
    updated: asString(fields.updated) ?? asString(raw.updated),
    selfUrl: asString(raw.self),
    browseUrl: deriveBrowseUrl(asString(raw.self), key),
    description: extractDescription(fields.description),
    raw
  };
}

function extractCreatedIssueKey(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  if (typeof raw.key === 'string') {
    return raw.key;
  }

  if (isRecord(raw.issue) && typeof raw.issue.key === 'string') {
    return raw.issue.key;
  }

  return undefined;
}

function extractProjects(value: unknown): Project[] {
  if (Array.isArray(value)) {
    return value.map(normalizeProject).filter((item): item is Project => Boolean(item));
  }

  if (isRecord(value) && Array.isArray(value.projects)) {
    return value.projects
      .map(normalizeProject)
      .filter((item): item is Project => Boolean(item));
  }

  return [];
}

function extractBoards(value: unknown): { boards: Board[]; total?: number; hasMore: boolean } {
  const collection = Array.isArray(value)
    ? { boards: value, total: value.length, hasMore: false }
    : isRecord(value) && Array.isArray(value.values)
      ? {
          boards: value.values,
          total: asNumber(value.total),
          hasMore:
            Boolean(value.nextPageToken) ||
            (typeof value.isLast === 'boolean' ? !value.isLast : false)
        }
      : isRecord(value) && Array.isArray(value.boards)
        ? {
            boards: value.boards,
            total: asNumber(value.total),
            hasMore:
              Boolean(value.nextPageToken) ||
              (typeof value.isLast === 'boolean' ? !value.isLast : false)
          }
        : { boards: [], total: undefined, hasMore: false };

  const boards = collection.boards
    .map(normalizeBoard)
    .filter((item): item is Board => Boolean(item));
  const hasMore =
    collection.hasMore ||
    (typeof collection.total === 'number' ? boards.length < collection.total : false);

  return {
    boards,
    total: collection.total,
    hasMore
  };
}

function extractIssues(value: unknown): { issues: IssueSummary[]; total?: number; hasMore: boolean } {
  const collection = Array.isArray(value)
    ? { issues: value, total: value.length, hasMore: false }
    : isRecord(value) && Array.isArray(value.issues)
      ? {
          issues: value.issues,
          total: asNumber(value.total),
          hasMore:
            Boolean(value.nextPageToken) ||
            (typeof value.isLast === 'boolean' ? !value.isLast : false)
        }
      : { issues: [], total: undefined, hasMore: false };

  const issues = collection.issues
    .map(normalizeIssue)
    .filter((item): item is IssueSummary => Boolean(item));
  const hasMore =
    collection.hasMore ||
    (typeof collection.total === 'number' ? issues.length < collection.total : false);

  return {
    issues,
    total: collection.total,
    hasMore
  };
}

function extractTransitions(value: unknown): WorkflowTransition[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.transitions)
      ? value.transitions
      : [];

  return list
    .map(normalizeTransition)
    .filter((item): item is WorkflowTransition => Boolean(item));
}

function extractComments(value: unknown): IssueComment[] {
  const fields = isRecord(value) && isRecord(value.fields) ? value.fields : undefined;
  const fieldComment = fields && isRecord(fields.comment) ? fields.comment : undefined;
  const list = Array.isArray(value)
    ? value
    : fieldComment && Array.isArray(fieldComment.comments)
      ? fieldComment.comments
      : isRecord(value) && Array.isArray(value.comments)
        ? value.comments
        : [];

  return list
    .map(normalizeComment)
    .filter((item): item is IssueComment => Boolean(item))
    .sort((left, right) =>
      (right.created ?? right.updated ?? '').localeCompare(left.created ?? left.updated ?? '')
    );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function boardMatchesFilters(board: Board, filters: BoardFilters): boolean {
  if (filters.projectKeys.length > 0 && (!board.projectKey || !filters.projectKeys.includes(board.projectKey))) {
    return false;
  }

  if (filters.types.length > 0 && !filters.types.includes(board.type)) {
    return false;
  }

  if (filters.searchText.trim().length === 0) {
    return true;
  }

  const haystack = `${board.name} ${board.projectKey ?? ''} ${board.projectName ?? ''} ${board.locationName ?? ''}`.toLowerCase();
  return haystack.includes(filters.searchText.trim().toLowerCase());
}

function statusCategoryRank(statusCategory?: string): number {
  switch (statusCategory?.toLowerCase()) {
    case 'todo':
      return 0;
    case 'indeterminate':
      return 1;
    case 'done':
      return 2;
    default:
      return 3;
  }
}

function commonStatusRank(statusName: string): number {
  switch (statusName.toLowerCase()) {
    case 'backlog':
      return 0;
    case 'to do':
      return 1;
    case 'selected for development':
      return 2;
    case 'in progress':
      return 3;
    case 'blocked':
      return 4;
    case 'done':
      return 5;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function sortIssuesByUpdated(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftUpdated = left.updated ?? '';
    const rightUpdated = right.updated ?? '';
    return rightUpdated.localeCompare(leftUpdated) || left.key.localeCompare(right.key);
  });
}

function buildBoardColumns(issues: IssueSummary[]): BoardColumn[] {
  const issuesByStatus = new Map<string, IssueSummary[]>();
  const statusCategories = new Map<string, string | undefined>();

  for (const issue of issues) {
    const statusName = issue.status || 'Unknown';
    const existing = issuesByStatus.get(statusName) ?? [];
    existing.push(issue);
    issuesByStatus.set(statusName, existing);

    if (!statusCategories.has(statusName)) {
      statusCategories.set(statusName, issue.statusCategory);
    }
  }

  return [...issuesByStatus.entries()]
    .sort((left, right) => {
      const leftCategory = statusCategories.get(left[0]);
      const rightCategory = statusCategories.get(right[0]);
      return (
        statusCategoryRank(leftCategory) - statusCategoryRank(rightCategory) ||
        commonStatusRank(left[0]) - commonStatusRank(right[0]) ||
        left[0].localeCompare(right[0])
      );
    })
    .map(([statusName, statusIssues]) => ({
      id: `status:${statusName}`,
      name: statusName,
      statusCategory: statusCategories.get(statusName),
      issues: sortIssuesByUpdated(statusIssues)
    }));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JiraService implements IssueTrackerService {
  public readonly mode: BackendMode = 'jira';
  private readonly client: McpClientWrapper;
  private cachedProjects?: Project[];
  private capabilities?: JiraCapabilities;
  private connectionSignature?: string;
  private parentFieldMode: ParentFieldMode = 'parent';
  private toolCount = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly output: vscode.OutputChannel
  ) {
    this.client = new McpClientWrapper(output);
  }

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.cachedProjects = undefined;
    this.capabilities = undefined;
    this.connectionSignature = undefined;
    this.parentFieldMode = 'parent';
    await this.client.disconnect();
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    const connection = await this.configStore.getConnectionConfig(this.context);
    if (!connection) {
      return {
        status: 'error',
        message: 'No Jira MCP connection is configured.',
        toolCount: 0
      };
    }

    try {
      await this.client.connect(connection);
      this.cachedProjects = undefined;
      this.parentFieldMode = 'parent';
      this.connectionSignature = JSON.stringify(connection);
      const tools = await this.client.listTools(connection.timeoutMs);
      this.toolCount = tools.length;
      this.capabilities = this.requireCapabilities(tools);
      const projects = await this.getProjects(false);
      return {
        status: projects.length === 0 ? 'warning' : 'ok',
        message:
          projects.length === 0
            ? 'Connected, but no Jira projects are accessible.'
            : `Connected. ${projects.length} accessible project(s) found.`,
        toolCount: this.toolCount,
        projectCount: projects.length,
        serverName: this.client.getServerName()
      };
    } catch (error) {
      return {
        status: 'error',
        message: getErrorMessage(error),
        toolCount: this.toolCount,
        serverName: this.client.getServerName()
      };
    }
  }

  public async getProjects(forceRefresh = false): Promise<Project[]> {
    if (this.cachedProjects && !forceRefresh) {
      return this.cachedProjects;
    }

    const { config, capabilities } = await this.ensureConnected();
    const response = await this.client.callTool(
      capabilities.getProjects,
      { include_archived: false },
      config.timeoutMs
    );

    this.cachedProjects = extractProjects(response.value);
    return this.cachedProjects;
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    const { config, capabilities } = await this.ensureConnected();
    const attemptModes: ParentFieldMode[] =
      filters.parentKey && this.parentFieldMode === 'parent'
        ? ['parent', 'parentEpic']
        : [this.parentFieldMode];

    let lastError: unknown;

    for (const mode of attemptModes) {
      try {
        const jql = buildIssuesJql(filters, mode);
        const response = await this.client.callTool(
          capabilities.searchIssues,
          {
            jql,
            fields: 'summary,status,issuetype,assignee,priority,updated,project',
            limit: pageSize,
            start_at: startAt
          },
          config.timeoutMs
        );

        this.parentFieldMode = mode;
        const issues = extractIssues(response.value);
        const hasMore =
          issues.hasMore ||
          (typeof issues.total === 'number' ? startAt + issues.issues.length < issues.total : false);

        return {
          issues: issues.issues,
          total: issues.total,
          hasMore
        };
      } catch (error) {
        lastError = error;
        this.output.appendLine(
          `[jira] Issue search failed using parent field mode "${mode}": ${getErrorMessage(error)}`
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    const metadataFilters: IssueFilters = {
      ...filters,
      statuses: [],
      issueTypes: []
    };
    const page = await this.getIssues(metadataFilters, 0, 50);
    const transitionStatuses = (
      await Promise.all(
        page.issues
          .map(issue => issue.key)
          .filter((issueKey, index, array) => array.indexOf(issueKey) === index)
          .slice(0, 20)
          .map(async issueKey => {
            try {
              return (await this.getTransitions(issueKey))
                .map(transition => transition.toStatus ?? transition.name)
                .filter((status): status is string => Boolean(status && status.trim().length > 0));
            } catch {
              return [];
            }
          })
      )
    ).flat();

    return {
      statuses: uniqueSorted([...page.issues.map(issue => issue.status), ...transitionStatuses]),
      issueTypes: uniqueSorted(page.issues.map(issue => issue.issueType))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    const { config, capabilities } = await this.ensureConnected();
    const allowedParentTypes = options?.childIssueType
      ? getParentRule(options.childIssueType, this.mode).allowedParentTypes
      : ['Epic'];
    if (allowedParentTypes.length === 0) {
      return [];
    }

    const jql = buildParentItemsJql(filters.projectKeys, filters.statuses, searchText, allowedParentTypes);
    const response = await this.client.callTool(
      capabilities.searchIssues,
      {
        jql,
        fields: 'summary,status,issuetype,project,updated',
        limit: 50,
        start_at: 0
      },
      config.timeoutMs
    );

    return extractIssues(response.value).issues;
  }

  public async supportsBoards(): Promise<boolean> {
    try {
      const { capabilities } = await this.ensureConnected();
      return Boolean(capabilities.getAgileBoards && capabilities.getBoardIssues);
    } catch {
      return false;
    }
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const { config, capabilities } = await this.ensureConnected();
    const boardCapabilities = this.requireBoardCapabilities(capabilities);
    const pageSize = 50;
    const boards: Board[] = [];
    const seenBoardIds = new Set<string>();
    let startAt = 0;

    while (true) {
      const response = await this.client.callTool(
        boardCapabilities.getAgileBoards,
        {
          board_name: filters.searchText.trim() || undefined,
          project_key: filters.projectKeys.length === 1 ? filters.projectKeys[0] : undefined,
          board_type: filters.types.length === 1 ? filters.types[0] : undefined,
          start_at: startAt,
          limit: pageSize
        },
        config.timeoutMs
      );

      const page = extractBoards(response.value);
      for (const board of page.boards) {
        if (seenBoardIds.has(board.id) || !boardMatchesFilters(board, filters)) {
          continue;
        }

        seenBoardIds.add(board.id);
        boards.push(board);
      }

      if (!page.hasMore || page.boards.length === 0) {
        break;
      }

      startAt += page.boards.length;
    }

    return boards.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const { config, capabilities } = await this.ensureConnected();
    const boardCapabilities = this.requireBoardCapabilities(capabilities);
    const pageSize = 50;
    const issues: IssueSummary[] = [];
    let startAt = 0;

    while (true) {
      const response = await this.client.callTool(
        boardCapabilities.getBoardIssues,
        {
          board_id: board.id,
          jql: 'order by updated desc',
          fields: 'summary,status,issuetype,assignee,priority,updated,project',
          start_at: startAt,
          limit: pageSize
        },
        config.timeoutMs
      );

      const page = extractIssues(response.value);
      issues.push(...page.issues);

      if (!page.hasMore || page.issues.length === 0) {
        break;
      }

      startAt += page.issues.length;
    }

    return {
      board,
      issues: sortIssuesByUpdated(issues),
      columns: buildBoardColumns(issues)
    };
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    throw new Error('Boards cannot be edited in Jira Connected mode.');
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Creating boards is not supported in Jira Connected mode.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Boards cannot be deleted in Jira Connected mode.');
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const { config, capabilities } = await this.ensureConnected();
    const response = await this.client.callTool(
      capabilities.getIssue,
      {
        issue_key: issueKey,
        fields: 'summary,status,issuetype,assignee,priority,created,updated,project,description,parent,comment',
        comment_limit: 50
      },
      config.timeoutMs
    );

    const issue = normalizeIssue(response.value);
    if (!issue) {
      throw new Error(`Unable to load details for ${issueKey}.`);
    }

    return {
      ...issue,
      comments: extractComments(response.value)
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const { config, capabilities } = await this.ensureConnected();
    if (!capabilities.createIssue) {
      throw new Error(
        'The Jira MCP server does not expose issue creation. Expected a create issue capability.'
      );
    }

    const issueType = input.issueType.trim();
    if (issueType.length === 0) {
      throw new Error('Issue type cannot be empty.');
    }

    const parentKey = input.parentKey?.trim() || undefined;
    await this.validateParentSelection(input.projectKey, issueType, parentKey);
    const additionalFieldsPayload: Record<string, unknown> = {};
    if (parentKey) {
      if (isSubtaskIssueType(issueType)) {
        additionalFieldsPayload.parent = parentKey;
      } else {
        additionalFieldsPayload.epicKey = parentKey;
      }
    }
    const additionalFields =
      Object.keys(additionalFieldsPayload).length > 0
        ? JSON.stringify(additionalFieldsPayload)
        : undefined;
    const response = await this.client.callTool(
      capabilities.createIssue,
      {
        project_key: input.projectKey,
        summary: input.summary,
        issue_type: issueType,
        description: input.description,
        additional_fields: additionalFields
      },
      config.timeoutMs
    );

    const issueKey = normalizeIssue(response.value)?.key ?? extractCreatedIssueKey(response.value);
    if (!issueKey) {
      throw new Error('The Jira MCP server did not return the created issue key.');
    }

    return this.getIssue(issueKey);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const { config, capabilities } = await this.ensureConnected();
    if (!capabilities.updateIssue) {
      throw new Error(
        'The Jira MCP server does not expose issue updates. Expected an update issue capability.'
      );
    }

    const currentIssue = await this.getIssue(issueKey);
    const nextIssueType =
      typeof input.issueType === 'string' && input.issueType.trim().length > 0
        ? input.issueType.trim()
        : currentIssue.issueType;
    const hasParentPatch = Object.prototype.hasOwnProperty.call(input, 'parentKey');
    const nextParentKey = hasParentPatch ? input.parentKey?.trim() || undefined : currentIssue.parentKey;
    await this.validateParentSelection(currentIssue.projectKey, nextIssueType, nextParentKey, issueKey);

    const fieldsPayload: Record<string, unknown> = {};
    if (typeof input.summary === 'string') {
      const summary = input.summary.trim();
      if (summary.length === 0) {
        throw new Error('Summary cannot be empty.');
      }
      fieldsPayload.summary = summary;
    }
    if (typeof input.description === 'string') {
      fieldsPayload.description = input.description;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      fieldsPayload.assignee = input.assignee?.trim() || null;
    }

    const additionalFields: Record<string, unknown> = {};
    if (hasParentPatch || typeof input.issueType === 'string') {
      if (isParentIssueType(nextIssueType)) {
        additionalFields.parent = null;
        additionalFields.epicKey = null;
      } else if (isSubtaskIssueType(nextIssueType)) {
        additionalFields.parent = nextParentKey ?? null;
        additionalFields.epicKey = null;
      } else {
        additionalFields.parent = null;
        additionalFields.epicKey = nextParentKey ?? null;
      }
    }
    if (typeof input.priority === 'string') {
      const priority = input.priority.trim();
      if (priority.length === 0) {
        throw new Error('Priority cannot be empty.');
      }
      additionalFields.priority = { name: priority };
    }
    if (typeof input.issueType === 'string') {
      const issueType = input.issueType.trim();
      if (issueType.length === 0) {
        throw new Error('Issue type cannot be empty.');
      }
      additionalFields.issuetype = { name: issueType };
    }

    await this.client.callTool(
      capabilities.updateIssue,
      {
        issue_key: issueKey,
        fields: JSON.stringify(fieldsPayload),
        additional_fields:
          Object.keys(additionalFields).length > 0 ? JSON.stringify(additionalFields) : undefined
      },
      config.timeoutMs
    );

    return this.getIssue(issueKey);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    const { config, capabilities } = await this.ensureConnected();
    if (!capabilities.deleteIssue) {
      throw new Error(
        'The Jira MCP server does not expose issue deletion. Expected a delete issue capability.'
      );
    }

    await this.client.callTool(
      capabilities.deleteIssue,
      {
        issue_key: issueKey
      },
      config.timeoutMs
    );
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const { config, capabilities } = await this.ensureConnected();
    if (!capabilities.addComment) {
      throw new Error(
        'The Jira MCP server does not expose comment creation. Expected an add comment capability.'
      );
    }

    const commentBody = body.trim();
    if (commentBody.length === 0) {
      throw new Error('Comment cannot be empty.');
    }

    await this.client.callTool(
      capabilities.addComment,
      {
        issue_key: issueKey,
        body: commentBody
      },
      config.timeoutMs
    );
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    const { config, capabilities } = await this.ensureConnected();
    const response = await this.client.callTool(
      capabilities.getTransitions,
      {
        issue_key: issueKey
      },
      config.timeoutMs
    );

    return extractTransitions(response.value);
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const { config, capabilities } = await this.ensureConnected();
    await this.client.callTool(
      capabilities.transitionIssue,
      {
        issue_key: issueKey,
        transition_id: transitionId
      },
      config.timeoutMs
    );
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    if (issue.browseUrl) {
      return issue.browseUrl;
    }

    const details = await this.getIssue(issue.key);
    return details.browseUrl;
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    return undefined;
  }

  private async ensureConnected(explicitConnection?: ConnectionConfig): Promise<{
    config: ConnectionConfig;
    capabilities: JiraCapabilities;
  }> {
    const config =
      explicitConnection ?? (await this.configStore.getConnectionConfig(this.context));
    if (!config) {
      throw new Error(
        'No Jira MCP connection is configured. Run "Ticket Manager: Configure Connection".'
      );
    }

    const signature = JSON.stringify(config);
    if (this.connectionSignature !== signature) {
      this.cachedProjects = undefined;
      this.capabilities = undefined;
      this.connectionSignature = signature;
      this.parentFieldMode = 'parent';
    }

    await this.client.connect(config);

    if (!this.capabilities) {
      const tools = await this.client.listTools(config.timeoutMs);
      this.toolCount = tools.length;
      this.capabilities = this.requireCapabilities(tools);
    }

    return {
      config,
      capabilities: this.capabilities
    };
  }

  private requireCapabilities(tools: ToolDescriptor[]): JiraCapabilities {
    const resolution = resolveJiraCapabilities(tools);
    if (!resolution.capabilities) {
      throw new Error(
        `The Jira MCP server is missing required tools: ${resolution.missing.join(', ')}.`
      );
    }

    return resolution.capabilities;
  }

  private requireBoardCapabilities(capabilities: JiraCapabilities): {
    getAgileBoards: string;
    getBoardIssues: string;
  } {
    if (!capabilities.getAgileBoards || !capabilities.getBoardIssues) {
      throw new Error(
        'The Jira MCP server does not expose board tools. Expected agile board and board issue capabilities.'
      );
    }

    return {
      getAgileBoards: capabilities.getAgileBoards,
      getBoardIssues: capabilities.getBoardIssues
    };
  }

  private async validateParentSelection(
    projectKey: string,
    issueType: string,
    parentKey: string | undefined,
    currentIssueKey?: string
  ): Promise<void> {
    const rule = getParentRule(issueType, this.mode);
    const issueLabel = normalizeIssueTypeLabel(issueType);
    if (!rule.canHaveParent) {
      if (parentKey) {
        throw new Error(`${issueLabel} items cannot have a parent.`);
      }
      return;
    }

    if (!parentKey) {
      if (rule.requiresParent) {
        throw new Error(`${rule.defaultLabel} is required for ${issueLabel} items.`);
      }
      return;
    }

    if (parentKey === currentIssueKey) {
      throw new Error('An item cannot be its own parent.');
    }

    const parentIssue = await this.getIssue(parentKey);
    if (parentIssue.projectKey !== projectKey) {
      throw new Error(`${rule.defaultLabel} ${parentKey} must be in the same project.`);
    }
    if (!isAllowedParentType(parentIssue.issueType, issueType, this.mode)) {
      throw new Error(buildParentValidationMessage(issueType, this.mode, parentIssue.issueType));
    }
  }

  public dispose(): void {
    void this.reset();
  }
}
