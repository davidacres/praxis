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
  CreateIssueInput,
  FilterMetadata,
  JiraCapabilities,
  IssueDetails,
  IssueFilters,
  IssueSummary,
  PagedIssues,
  Project,
  ToolDescriptor,
  WorkflowTransition
} from '../types';

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
    assignee: asString(assignee.displayName) ?? asString(assignee.name),
    priority: asString(priority.name) ?? asString(fields.priority),
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
    case 'to do':
      return 0;
    case 'selected for development':
      return 1;
    case 'in progress':
      return 2;
    case 'blocked':
      return 3;
    case 'done':
      return 4;
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

    return {
      statuses: uniqueSorted(page.issues.map(issue => issue.status)),
      issueTypes: uniqueSorted(page.issues.map(issue => issue.issueType))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string
  ): Promise<IssueSummary[]> {
    const { config, capabilities } = await this.ensureConnected();
    const jql = buildParentItemsJql(filters.projectKeys, searchText);
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

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const { config, capabilities } = await this.ensureConnected();
    const response = await this.client.callTool(
      capabilities.getIssue,
      {
        issue_key: issueKey,
        fields: 'summary,status,issuetype,assignee,priority,updated,project,description'
      },
      config.timeoutMs
    );

    const issue = normalizeIssue(response.value);
    if (!issue) {
      throw new Error(`Unable to load details for ${issueKey}.`);
    }

    return issue;
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const { config, capabilities } = await this.ensureConnected();
    if (!capabilities.createIssue) {
      throw new Error(
        'The Jira MCP server does not expose issue creation. Expected a create issue capability.'
      );
    }

    const additionalFields =
      input.parentKey?.trim().length
        ? JSON.stringify({
            epicKey: input.parentKey.trim()
          })
        : undefined;
    const response = await this.client.callTool(
      capabilities.createIssue,
      {
        project_key: input.projectKey,
        summary: input.summary,
        issue_type: input.issueType,
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

  public dispose(): void {
    void this.reset();
  }
}
