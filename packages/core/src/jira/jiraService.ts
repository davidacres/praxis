import { McpClientWrapper } from '../mcp/clientFactory';
import type { McpLogSink } from '../mcp/clientFactory';
import type { JiraMcpConnectionResolution } from './jiraMcpConnectionResolver';
import type { JiraConfigStore } from './jiraConfigStore';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import {
  buildBoardColumns,
  buildBoardStatusOrder,
  deriveBrowseUrl,
  extractArray,
  isRecord,
  asString,
  toArray,
  normalizeComment,
  normalizeAttachment,
  normalizeIssue,
  normalizeLinkedIssueReferences,
  normalizeProject,
  normalizeTransition,
  normalizeFieldName
} from './jiraShape';
import {
  buildParentValidationMessage,
  getParentRule,
  isAllowedParentType,
  isParentIssueType,
  isSubtaskIssueType,
  normalizeIssueTypeLabel
} from '../issues/issueHierarchy';
import type {
  BackendMode,
  Board,
  BoardDetails,
  BoardFilters,
  ConnectionCheck,
  CreateBoardInput,
  CreateIssueInput,
  FilterMetadata,
  IssueAttachment,
  IssueComment,
  IssueDetails,
  IssueFilters,
  ParentItemQueryOptions,
  IssueSummary,
  PagedIssues,
  Project,
  SubTaskSummary,
  UpdateBoardInput,
  UpdateIssueInput,
  WorkflowTransition
} from '../types';

const COMMUNITY_TOOLS = {
  listProjects: 'atlassian-jira_get_all_projects',
  search: 'atlassian-jira_search',
  createIssue: 'atlassian-jira_create_issue',
  updateIssue: 'atlassian-jira_update_issue',
  deleteIssue: 'atlassian-jira_delete_issue',
  getIssue: 'atlassian-jira_get_issue',
  addComment: 'atlassian-jira_add_comment',
  getTransitions: 'atlassian-jira_get_transitions',
  transitionIssue: 'atlassian-jira_transition_issue',
  getAgileBoards: 'atlassian-jira_get_agile_boards',
  getBoardIssues: 'atlassian-jira_get_board_issues'
} as const;

const ATLASSIAN_TOOLS = {
  listAccessibleResources: 'mcp_com_atlassian_getAccessibleAtlassianResources',
  listProjects: 'mcp_com_atlassian_getVisibleJiraProjects',
  search: 'mcp_com_atlassian_searchJiraIssuesUsingJql',
  createIssue: 'mcp_com_atlassian_createJiraIssue',
  updateIssue: 'mcp_com_atlassian_updateJiraIssue',
  deleteIssue: 'mcp_com_atlassian_deleteJiraIssue',
  getIssue: 'mcp_com_atlassian_getJiraIssue',
  addComment: 'mcp_com_atlassian_addCommentToJiraIssue',
  getTransitions: 'mcp_com_atlassian_getTransitionsForJiraIssue'
} as const;

type Adapter = 'community' | 'atlassian';

/**
 * Atlassian's remote MCP server has shipped its tool surface both with the
 * `mcp_com_atlassian_` prefix and without it. Resolve a canonical (prefixed)
 * name to whichever variant the connected server actually exposes.
 */
const ATLASSIAN_TOOL_PREFIX = 'mcp_com_atlassian_';

/**
 * Operations Atlassian renamed outright on the current surface (keyed by the
 * canonical unprefixed name). `deleteJiraIssue` has no modern equivalent —
 * the server simply doesn't expose it.
 */
const ATLASSIAN_TOOL_ALIASES: Record<string, readonly string[]> = {
  updateJiraIssue: ['editJiraIssue']
};

function resolveExposedToolName(names: Set<string>, canonical: string): string | undefined {
  const candidates: string[] = [canonical];
  if (canonical.startsWith(ATLASSIAN_TOOL_PREFIX)) {
    const unprefixed = canonical.slice(ATLASSIAN_TOOL_PREFIX.length);
    candidates.push(unprefixed, ...(ATLASSIAN_TOOL_ALIASES[unprefixed] ?? []));
  }
  return candidates.find(name => names.has(name));
}

interface ResolvedTools {
  adapter: Adapter;
  names: Set<string>;
  /** Cloud ID for the official Atlassian tool surface, populated when a
   *  getAccessibleAtlassianResources call succeeds. */
  atlassianCloudId?: string;
}

interface JiraProjectSummary
  extends Pick<Project, 'id' | 'key' | 'name'> {}

interface AgileBoardEntry {
  id: string;
  name: string;
  type?: string;
  projectKey?: string;
  projectName?: string;
  locationName?: string;
  raw?: unknown;
}

function escapeJqlValue(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

function escapeJqlText(value: string): string {
  return value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function appendUniqueStatusName(
  orderedStatuses: string[],
  seen: Set<string>,
  statusName: string | undefined
): void {
  const trimmed = statusName?.trim();
  if (!trimmed || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  orderedStatuses.push(trimmed);
}

function sortIssuesByUpdated(issues: IssueSummary[]): IssueSummary[] {
  return [...issues].sort((left, right) => {
    const leftUpdated = left.updated ?? '';
    const rightUpdated = right.updated ?? '';
    return rightUpdated.localeCompare(leftUpdated) || left.key.localeCompare(right.key);
  });
}

const CUSTOM_JQL_BOARD_PREFIX = 'jql:custom:';

export class JiraService implements IssueTrackerService {
  public readonly mode: BackendMode = 'jiracloud';

  private readonly client: McpClientWrapper;
  private tools?: ResolvedTools;
  private cachedProjects?: JiraProjectSummary[];
  private currentUserDisplayName?: string;

  public constructor(
    private readonly configStore: JiraConfigStore,
    private readonly output: McpLogSink,
    private readonly connection: JiraMcpConnectionResolution
  ) {
    this.client = new McpClientWrapper(output);
  }

  // ── IssueTrackerService surface ────────────────────────────────────────────

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.cachedProjects = undefined;
    this.currentUserDisplayName = undefined;
    await this.client.disconnect();
    this.tools = undefined;
  }

  public dispose(): void {
    void this.reset();
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    if (!(await this.configStore.hasJiraMcpConfigPublic())) {
      return {
        status: 'error',
        message: 'No Jira MCP connection is configured.',
        toolCount: 0
      };
    }

    try {
      await this.ensureConnected();
      const projects = await this.getProjects(true);
      if (projects.length === 0) {
        return {
          status: 'warning',
          message: 'Connected, but no Jira projects are accessible.',
          toolCount: this.tools?.names.size ?? 0,
          projectCount: 0
        };
      }

      return {
        status: 'ok',
        message: `Connected. ${projects.length} accessible project(s) found.`,
        toolCount: this.tools?.names.size ?? 0,
        projectCount: projects.length
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        toolCount: 0
      };
    }
  }

  public async getProjects(forceRefresh = false): Promise<Project[]> {
    if (this.cachedProjects && !forceRefresh) {
      return this.cachedProjects;
    }

    await this.ensureConnected();
    const tools = this.requireResolved();
    const rawProjects = tools.adapter === 'atlassian'
      ? await this.callJsonTool(
          resolveExposedToolName(tools.names, ATLASSIAN_TOOLS.listProjects) ??
            ATLASSIAN_TOOLS.listProjects,
          {
            cloudId: await this.resolveRequiredCloudId(),
            maxResults: 100
          }
        )
      : await this.callJsonTool(COMMUNITY_TOOLS.listProjects, {});

    const items = extractArray(rawProjects, ['values', 'projects'])
      .map(normalizeProject)
      .filter((item): item is Project => Boolean(item))
      .sort((left, right) => left.key.localeCompare(right.key));
    this.cachedProjects = items;
    this.currentUserDisplayName = this.currentUserDisplayName || (await this.resolveSelfDisplayName());
    return items;
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    await this.ensureConnected();

    const jql = this.buildIssueSearchJql(filters);
    const fields = [
      'summary',
      'status',
      'issuetype',
      'assignee',
      'priority',
      'updated',
      'project',
      'description',
      'parent'
    ];

    const search = await this.executeSearch(jql, fields, startAt, pageSize);
    return {
      issues: search.issues,
      total: search.total,
      hasMore: startAt + search.issues.length < search.total
    };
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    await this.ensureConnected();
    const jql = this.buildIssueSearchJql({
      ...filters,
      statuses: [],
      issueTypes: [],
      searchText: '',
      parentKey: undefined
    });
    const search = await this.executeSearch(jql, ['status', 'issuetype', 'project'], 0, 200);
    return {
      statuses: [...new Set(search.issues.map(issue => issue.status))].sort((a, b) =>
        a.localeCompare(b)
      ),
      issueTypes: [...new Set(search.issues.map(issue => issue.issueType))].sort((a, b) =>
        a.localeCompare(b)
      )
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    await this.ensureConnected();

    const allowedParentTypes = options?.childIssueType
      ? getParentRule(options.childIssueType, this.mode).allowedParentTypes
      : ['Epic'];

    if (allowedParentTypes.length === 0) {
      return [];
    }

    const clauses = [`issuetype in (${allowedParentTypes.map(escapeJqlValue).join(', ')})`];
    const projectScope = this.resolveProjectScope(filters.projectKeys);
    if (projectScope.length > 0) {
      clauses.push(`project in (${projectScope.map(escapeJqlValue).join(', ')})`);
    }
    if (filters.statuses.length > 0) {
      clauses.push(`status in (${filters.statuses.map(escapeJqlValue).join(', ')})`);
    }
    const trimmed = searchText?.trim();
    if (trimmed) {
      clauses.push(`text ~ ${escapeJqlValue(escapeJqlText(trimmed))}`);
    }

    const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
    const search = await this.executeAllIssues(jql, [
      'summary',
      'status',
      'issuetype',
      'project',
      'description',
      'updated'
    ]);

    return search.slice(0, 50).sort((left, right) => {
      const leftUpdated = left.updated ? Date.parse(left.updated) : 0;
      const rightUpdated = right.updated ? Date.parse(right.updated) : 0;
      return rightUpdated - leftUpdated;
    });
  }

  public async supportsBoards(): Promise<boolean> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    return (
      tools.adapter === 'community' && tools.names.has(COMMUNITY_TOOLS.getAgileBoards)
    ) || this.configStore.getJiraMcpEpicKey().trim().length > 0
      || this.configStore.getJiraMcpBoardJql().trim().length > 0;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    await this.ensureConnected();
    const boards: Board[] = [];

    try {
      boards.push(...(await this.fetchAgileBoards()));
    } catch (error) {
      this.output.appendLine(
        `[jiramcp] Failed to load agile boards: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const linkedEpicKey = this.configStore.getJiraMcpEpicKey().trim();
    if (linkedEpicKey) {
      try {
        const epic = await this.getIssue(linkedEpicKey);
        boards.push({
          id: `epic:${epic.key}`,
          name: this.configStore.getJiraMcpEpicBoardName().trim() || `${epic.key} ${epic.summary}`,
          type: 'epic',
          projectKey: epic.projectKey,
          projectName: epic.projectName,
          locationName: epic.projectName,
          raw: { epicKey: epic.key }
        });
      } catch (error) {
        this.output.appendLine(
          `[jiramcp] Failed to load linked epic ${linkedEpicKey}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const linkedBoardJql = this.configStore.getJiraMcpBoardJql().trim();
    if (linkedBoardJql) {
      boards.push({
        id: 'jql:workspace',
        name: this.configStore.getJiraMcpBoardName().trim() || this.buildJqlBoardName(linkedBoardJql),
        type: 'jql',
        raw: { jql: linkedBoardJql }
      });
    }

    return boards.filter(board => this.matchesBoardFilters(board, filters));
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    await this.ensureConnected();
    const agileBoardId = this.parseAgileBoardId(board);
    if (agileBoardId) {
      const issues = sortIssuesByUpdated(await this.fetchAgileBoardIssues(agileBoardId));
      const columnStatusOrder = await this.fetchBoardWorkflowStatuses(issues);
      return {
        board,
        issues,
        columns: buildBoardColumns(issues),
        columnStatusOrder
      };
    }

    const epicKey = this.parseEpicKey(board.id);
    let jql: string;
    if (epicKey) {
      jql = this.buildBoardJqlFromQuery(
        this.buildLinkedEpicDescendantClause(epicKey)
      );
    } else {
      const boardJql = this.parseJqlBoardQuery(board);
      if (!boardJql) {
        throw new Error('Invalid Jira MCP board identifier.');
      }
      jql = this.buildBoardJqlFromQuery(boardJql);
    }

    const issues = sortIssuesByUpdated(
      await this.executeAllIssues(jql, [
        'summary',
        'status',
        'issuetype',
        'assignee',
        'priority',
        'updated',
        'project',
        'description',
        'parent'
      ])
    );
    const columnStatusOrder = await this.fetchBoardWorkflowStatuses(issues);

    return {
      board,
      issues,
      columns: buildBoardColumns(issues),
      columnStatusOrder
    };
  }

  public async validateBoardJql(jql: string): Promise<void> {
    const trimmedJql = jql.trim();
    if (!trimmedJql) {
      throw new Error('Jira board JQL cannot be empty.');
    }
    await this.executeSearch(
      this.buildBoardJqlFromQuery(trimmedJql),
      ['key'],
      0,
      1
    );
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error(
      'Creating boards is not supported in Jira MCP mode. Boards are derived from the linked epic or configured JQL query.'
    );
  }

  public async updateBoard(boardId: string, input: UpdateBoardInput): Promise<Board> {
    const inputName = input.name?.trim();
    const inputJql = input.jql?.trim();
    if (!inputName) {
      throw new Error('Board name cannot be empty.');
    }

    if (boardId.startsWith('epic:')) {
      if (inputJql && inputJql.length > 0) {
        throw new Error('Epic boards do not support a custom JQL query.');
      }
      const epicKey = this.parseEpicKey(boardId);
      if (!epicKey) {
        throw new Error('Invalid Jira MCP board identifier.');
      }
      const epic = await this.getIssue(epicKey);
      await this.configStore.setJiraMcpEpicBoardName(inputName);
      return {
        id: boardId,
        name: inputName,
        type: 'epic',
        projectKey: epic.projectKey,
        projectName: epic.projectName,
        locationName: epic.projectName,
        raw: { epicKey: epic.key }
      };
    }

    if (boardId === 'jql:workspace') {
      const boardJql = this.configStore.getJiraMcpBoardJql().trim();
      if (!boardJql) {
        throw new Error('Jira MCP board query is not configured.');
      }
      if (inputJql !== undefined) {
        if (!inputJql) {
          throw new Error('Board JQL cannot be empty.');
        }
        await this.configStore.setJiraMcpBoardJql(inputJql);
      }
      await this.configStore.setJiraMcpBoardName(inputName);
      return {
        id: boardId,
        name: inputName,
        type: 'jql',
        raw: { jql: inputJql || boardJql }
      };
    }

    throw new Error('Boards cannot be edited in Jira MCP mode.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Boards cannot be deleted in Jira MCP mode.');
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const browseBase = this.getBrowseBaseUrl();

    const issueFields = [
      'summary',
      'status',
      'issuetype',
      'assignee',
      'priority',
      'created',
      'updated',
      'project',
      'description',
      'parent',
      'comment',
      'attachment',
      'issuelinks'
    ];

    const args: Record<string, unknown> =
      tools.adapter === 'atlassian'
        ? {
            cloudId: await this.resolveRequiredCloudId(),
            issueIdOrKey: issueKey,
            fields: issueFields
          }
        : { issue_key: issueKey, fields: issueFields.join(',') };

    const response = await this.callJsonTool(this.requireTool(tools, 'getIssue'), args);
    const fieldsObject = isRecord(response) && isRecord(response.fields) ? response.fields : {};
    const issue = normalizeIssue(response, browseBase);
    if (!issue) {
      throw new Error(`Unable to load details for ${issueKey}.`);
    }

    const comments = isRecord(fieldsObject.comment)
      ? toArray(fieldsObject.comment.comments)
          .map(normalizeComment)
          .filter((item): item is IssueComment => Boolean(item))
      : [];

    const attachments = toArray(fieldsObject.attachment)
      .map(normalizeAttachment)
      .filter((item): item is IssueAttachment => Boolean(item));

    const linkedIssues = normalizeLinkedIssueReferences(fieldsObject, [], browseBase);

    return {
      ...issue,
      comments,
      attachments,
      linkedIssues
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const issueType = input.issueType.trim();
    if (!issueType) {
      throw new Error('Issue type cannot be empty.');
    }

    const parentKey = input.parentKey?.trim() || undefined;
    await this.validateParentSelection(input.projectKey, issueType, parentKey);

    const payload = {
      project: { key: input.projectKey },
      summary: input.summary.trim(),
      issuetype: { name: issueType },
      description: input.description
    };

    const created = await this.createIssueRaw(payload, parentKey, issueType);
    const createdKey = asString(created?.key);
    if (!createdKey) {
      throw new Error('Jira MCP server did not return the created issue key.');
    }
    return this.getIssue(createdKey);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    await this.ensureConnected();
    const tools = this.requireResolved();

    const current = await this.getIssue(issueKey);
    const hasParentPatch = Object.prototype.hasOwnProperty.call(input, 'parentKey');
    const nextIssueType =
      typeof input.issueType === 'string' && input.issueType.trim().length > 0
        ? input.issueType.trim()
        : current.issueType;
    const nextParentKey = hasParentPatch ? input.parentKey?.trim() || undefined : current.parentKey;

    await this.validateParentSelection(current.projectKey, nextIssueType, nextParentKey, issueKey);

    const updates: Record<string, unknown> = {};

    if (typeof input.summary === 'string') {
      const summary = input.summary.trim();
      if (!summary) {
        throw new Error('Summary cannot be empty.');
      }
      updates.summary = summary;
    }
    if (typeof input.description === 'string') {
      updates.description = input.description;
    }
    if (typeof input.priority === 'string' && input.priority.trim().length > 0) {
      updates.priority = { name: input.priority.trim() };
    }
    if (typeof input.issueType === 'string' && input.issueType.trim().length > 0) {
      updates.issuetype = { name: input.issueType.trim() };
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      const assignee = input.assignee?.trim();
      updates.assignee = assignee ? { name: assignee } : null;
    }
    if (hasParentPatch) {
      if (isParentIssueType(nextIssueType)) {
        updates.parent = null;
      } else if (isSubtaskIssueType(nextIssueType)) {
        updates.parent = nextParentKey ? { key: nextParentKey } : null;
      } else {
        updates.parent = nextParentKey ? { key: nextParentKey } : null;
      }
    }

    await this.updateIssueRaw(issueKey, updates);
    return this.getIssue(issueKey);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const args: Record<string, unknown> =
      tools.adapter === 'atlassian'
        ? {
            cloudId: await this.resolveRequiredCloudId(),
            issueIdOrKey: issueKey
          }
        : { issue_key: issueKey };
    await this.callJsonTool(this.requireTool(tools, 'deleteIssue'), args);
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error('Comment cannot be empty.');
    }
    const args: Record<string, unknown> =
      tools.adapter === 'atlassian'
        ? {
            cloudId: await this.resolveRequiredCloudId(),
            issueIdOrKey: issueKey,
            body: trimmed
          }
        : { issue_key: issueKey, body: trimmed };
    await this.callJsonTool(this.requireTool(tools, 'addComment'), args);
  }

  public async attachFile(
    issueKey: string,
    filePath: string,
    fileName?: string
  ): Promise<void> {
    void issueKey;
    void filePath;
    void fileName;
    throw new Error(
      'Attaching files is not supported over Jira MCP. Use a comment with the file contents or attach via the web UI.'
    );
  }

  public async downloadAttachment(
    _issueKey: string,
    _attachment: IssueAttachment,
    _targetFilePath: string
  ): Promise<void> {
    throw new Error(
      'Downloading attachments is not supported over Jira MCP. Use the web UI to download attachments.'
    );
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const args: Record<string, unknown> =
      tools.adapter === 'atlassian'
        ? {
            cloudId: await this.resolveRequiredCloudId(),
            issueIdOrKey: issueKey
          }
        : { issue_key: issueKey };

    const response = await this.callJsonTool(this.requireTool(tools, 'getTransitions'), args);
    const transitions = extractArray(response, ['transitions']);
    return transitions
      .map(normalizeTransition)
      .filter((item): item is WorkflowTransition => Boolean(item));
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    if (tools.adapter !== 'community') {
      throw new Error(
        'The official Atlassian MCP server does not expose an issue transition tool. Move tickets via the web UI for this connection.'
      );
    }
    await this.callJsonTool(COMMUNITY_TOOLS.transitionIssue, {
      issue_key: issueKey,
      transition_id: transitionId
    });
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl ?? deriveBrowseUrl(this.getBrowseBaseUrl(), issue.key);
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    if (this.currentUserDisplayName) {
      return this.currentUserDisplayName;
    }
    this.currentUserDisplayName = await this.resolveSelfDisplayName();
    return this.currentUserDisplayName;
  }

  public async getSubTasks(parentKey: string): Promise<SubTaskSummary[]> {
    await this.ensureConnected();
    const jql = `parent = ${escapeJqlValue(parentKey)} ORDER BY key ASC`;
    const issues = await this.executeAllIssues(jql, [
      'summary',
      'status',
      'issuetype',
      'assignee'
    ]);

    return issues.map(issue => ({
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      issueType: issue.issueType,
      assignee: issue.assignee
    }));
  }

  public async createSubTasks(
    parentKey: string,
    projectKey: string,
    subTasks: Array<{ summary: string; description: string; issueType?: string }>
  ): Promise<string[]> {
    const createdKeys: string[] = [];
    for (const subTask of subTasks) {
      const created = await this.createIssue({
        projectKey,
        issueType: 'Sub-task',
        summary: subTask.summary,
        description: subTask.description,
        parentKey
      });
      createdKeys.push(created.key);
    }
    void parentKey;
    return createdKeys;
  }

  // ── MCP plumbing ──────────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    await this.client.connect(this.connection.config);
    if (!this.tools) {
      this.tools = await this.resolveTools();
    }
  }

  private requireResolved(): ResolvedTools {
    if (!this.tools) {
      throw new Error(
        'Jira MCP connection has not been established. Ensure the extension is configured for a Jira MCP server.'
      );
    }
    return this.tools;
  }

  private async resolveRequiredCloudId(): Promise<string> {
    const tools = this.requireResolved();
    if (tools.adapter !== 'atlassian') {
      throw new Error(
        'The Atlassian MCP cloudId has not been resolved. Re-run "Connect with Atlassian" to choose a Jira site.'
      );
    }
    if (!tools.atlassianCloudId) {
      // Consent propagation right after a fresh OAuth grant can make the
      // first accessible-resources call fail transiently — retry on demand
      // instead of poisoning the whole session with the sticky undefined.
      tools.atlassianCloudId = await this.resolveAtlassianCloudId(tools.names);
    }
    if (!tools.atlassianCloudId) {
      throw new Error(
        'The Atlassian MCP cloudId has not been resolved. Re-run "Connect with Atlassian" to choose a Jira site.'
      );
    }
    return tools.atlassianCloudId;
  }

  private requireTool(tools: ResolvedTools, operation: keyof typeof COMMUNITY_TOOLS): string {
    const name = COMMUNITY_TOOLS[operation];
    if (tools.names.has(name)) {
      return name;
    }
    const atlassianKey = operationToAtlassianKey(operation);
    if (atlassianKey && tools.adapter === 'atlassian') {
      const exposed = resolveExposedToolName(tools.names, atlassianKey);
      if (exposed) {
        return exposed;
      }
    }
    throw new Error(
      `The connected Jira MCP server does not expose a tool for ${operation}. ` +
        'Reconnect to a server that supports the required Jira tools.'
    );
  }

  private async resolveTools(): Promise<ResolvedTools> {
    const toolList = await this.client.listTools(this.connection.config.timeoutMs);
    const names = new Set(toolList.map(tool => tool.name));

    const hasAtlassian = Boolean(resolveExposedToolName(names, ATLASSIAN_TOOLS.search));
    const hasCommunity = names.has(COMMUNITY_TOOLS.search);

    if (hasAtlassian && !hasCommunity) {
      const cloudId = await this.resolveAtlassianCloudId(names);
      return { adapter: 'atlassian', names, atlassianCloudId: cloudId };
    }
    if (hasCommunity) {
      return { adapter: 'community', names };
    }
    // List what the server DID expose — with scoped OAuth tokens (e.g. a 3LO
    // app granted only JSM scopes) the answer is usually "tools, but none of
    // the Jira ones", which points at the app's console scopes, not auth.
    this.output.appendLine(
      `[jira] Unrecognized tool surface: ${[...names].sort().join(', ') || '(no tools)'}`
    );
    throw new Error(
      'The connected MCP server does not expose any recognized Jira tools. ' +
        'Connect to the community jira-mcp-server or the official mcp.com.atlassian server.'
    );
  }

  private async resolveAtlassianCloudId(names: Set<string>): Promise<string | undefined> {
    try {
      const payload = await this.callJsonTool(
        resolveExposedToolName(names, ATLASSIAN_TOOLS.listAccessibleResources) ??
          ATLASSIAN_TOOLS.listAccessibleResources,
        {}
      );
      const resources = extractArray(payload, ['resources', 'values']);
      if (resources.length === 0) {
        return undefined;
      }

      const configured = this.configStore.getJiraMcpSiteUrl().trim();
      if (configured) {
        const configuredLower = configured.toLowerCase();
        const match = resources.find(resource => {
          if (!isRecord(resource)) {
            return false;
          }
          const url = asString(resource.url)?.trim();
          if (!url) {
            return false;
          }
          return url.toLowerCase() === configuredLower;
        });
        const matchedId = match && isRecord(match) ? asString(match.id) : undefined;
        if (matchedId) {
          return matchedId;
        }
      }

      const first = resources[0];
      if (isRecord(first)) {
        const firstId = asString(first.id);
        if (firstId) {
          return firstId;
        }
      }
    } catch (error) {
      this.output.appendLine(
        `[jiramcp] Could not enumerate Atlassian cloud sites: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // accessible-resources can fail even with a perfectly good token (the MCP
    // gateway 500s on it for first-party 3LO tokens). The configured site URL
    // alone determines the cloudId, and `_edge/tenant_info` answers it without
    // auth — use it as the fallback.
    return this.resolveCloudIdFromTenantInfo();
  }

  private async resolveCloudIdFromTenantInfo(): Promise<string | undefined> {
    const siteUrl = this.configStore.getJiraMcpSiteUrl().trim();
    if (!siteUrl || typeof globalThis.fetch !== 'function') {
      return undefined;
    }

    let host: string;
    try {
      host = new URL(siteUrl.includes('://') ? siteUrl : `https://${siteUrl}`).hostname;
    } catch {
      return undefined;
    }
    if (!host) {
      return undefined;
    }

    try {
      const response = await globalThis.fetch(`https://${host}/_edge/tenant_info`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      const cloudId = isRecord(payload) ? asString(payload.cloudId) : undefined;
      if (cloudId) {
        this.output.appendLine(`[jiramcp] Resolved cloudId for ${host} via tenant_info.`);
      }
      return cloudId;
    } catch (error) {
      this.output.appendLine(
        `[jiramcp] tenant_info lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private async resolveSelfDisplayName(): Promise<string | undefined> {
    try {
      const jql = 'assignee = currentUser() ORDER BY updated DESC';
      const search = await this.executeSearch(jql, ['assignee'], 0, 1);
      const first = search.issues[0];
      return first?.assignee;
    } catch {
      return undefined;
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const payload = await this.client.callTool(name, args, this.connection.config.timeoutMs);
    return payload.value ?? payload.raw;
  }

  private async callJsonTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const value = await this.callTool(name, args);
    if (value === undefined || value === null) {
      return undefined;
    }
    return value;
  }

  private getBrowseBaseUrl(): string {
    const candidate = this.configStore.getJiraMcpSiteUrl().trim();
    if (candidate) {
      return candidate.replace(/\/$/, '');
    }
    const fallback = this.configStore.getJiraDefaultBaseUrl().trim();
    return fallback.replace(/\/$/, '');
  }

  private async executeSearch(
    jql: string,
    fields: string[],
    startAt: number,
    maxResults: number
  ): Promise<{ issues: IssueSummary[]; total: number }> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const browseBase = this.getBrowseBaseUrl();
    const encoder = tools.adapter === 'atlassian'
      ? (fieldList: string[]) => fieldList
      : (fieldList: string[]) => fieldList.join(',');

    const args: Record<string, unknown> =
      tools.adapter === 'atlassian'
        ? {
            cloudId: await this.resolveRequiredCloudId(),
            jql,
            maxResults,
            fields: encoder(fields)
          }
        : {
            jql,
            limit: maxResults,
            start_at: startAt,
            fields: encoder(fields)
          };

    const payload = await this.callJsonTool(this.requireTool(tools, 'search'), args);
    if (!isRecord(payload)) {
      return { issues: [], total: 0 };
    }

    const rawIssues = extractArray(payload, ['issues']);
    const issues = rawIssues
      .map(issue => normalizeIssue(issue, browseBase))
      .filter((item): item is IssueSummary => Boolean(item));

    let total = typeof payload.total === 'number' ? payload.total : startAt + issues.length;

    if (typeof total !== 'number' || Number.isNaN(total) || total < startAt + issues.length) {
      const nextToken = asString(payload.nextPageToken);
      total = startAt + issues.length + (nextToken ? 1 : 0);
    }

    return { issues, total };
  }

  private async executeAllIssues(
    jql: string,
    fields: string[]
  ): Promise<IssueSummary[]> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    const browseBase = this.getBrowseBaseUrl();
    const encoder = tools.adapter === 'atlassian'
      ? (fieldList: string[]) => fieldList
      : (fieldList: string[]) => fieldList.join(',');

    let nextPageToken: string | undefined;
    let startAt = 0;
    const pageSize = 100;
    const all: IssueSummary[] = [];

    while (true) {
      const args: Record<string, unknown> =
        tools.adapter === 'atlassian'
          ? {
              cloudId: await this.resolveRequiredCloudId(),
              jql,
              maxResults: pageSize,
              fields: encoder(fields),
              ...(nextPageToken ? { nextPageToken } : {})
            }
          : {
              jql,
              limit: pageSize,
              start_at: startAt,
              fields: encoder(fields)
            };

      const payload = await this.callJsonTool(this.requireTool(tools, 'search'), args);
      if (!isRecord(payload)) {
        break;
      }

      const rawIssues = extractArray(payload, ['issues']);
      const issues = rawIssues
        .map(issue => normalizeIssue(issue, browseBase))
        .filter((item): item is IssueSummary => Boolean(item));
      all.push(...issues);

      if (tools.adapter === 'atlassian') {
        nextPageToken = asString(payload.nextPageToken) || undefined;
        if (!nextPageToken || issues.length === 0) {
          break;
        }
      } else {
        if (issues.length < pageSize) {
          break;
        }
        startAt += issues.length;
      }
    }

    return all;
  }

  private async createIssueRaw(
    payload: Record<string, unknown>,
    parentKey: string | undefined,
    issueType: string
  ): Promise<Record<string, unknown> | undefined> {
    const tools = this.requireResolved();
    if (tools.adapter === 'atlassian') {
      const args: Record<string, unknown> = {
        cloudId: await this.resolveRequiredCloudId(),
        projectKey: (payload.project as { key?: string } | undefined)?.key ?? '',
        issueTypeName: issueType,
        summary: asString(payload.summary) ?? '',
        description: asString(payload.description)
      };
      if (parentKey) {
        args.parent = parentKey;
      }
      const response = await this.callJsonTool(this.requireTool(tools, 'createIssue'), args);
      return isRecord(response) ? response : undefined;
    }

    const additionalFields: Record<string, unknown> = {};
    if (parentKey) {
      additionalFields.parent = parentKey;
    }
    const args = {
      project_key: (payload.project as { key?: string } | undefined)?.key ?? '',
      summary: asString(payload.summary) ?? '',
      issue_type: issueType,
      description: asString(payload.description),
      additional_fields: Object.keys(additionalFields).length > 0 ? JSON.stringify(additionalFields) : undefined
    };
    const response = await this.callJsonTool(COMMUNITY_TOOLS.createIssue, args);
    return isRecord(response) ? response : undefined;
  }

  private async updateIssueRaw(
    issueKey: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    const tools = this.requireResolved();
    if (tools.adapter === 'atlassian') {
      const args: Record<string, unknown> = {
        cloudId: await this.resolveRequiredCloudId(),
        issueIdOrKey: issueKey
      };
      if (typeof updates.summary === 'string') {
        args.summary = updates.summary;
      } else {
        delete updates.summary;
      }
      if (typeof updates.description === 'string') {
        args.description = updates.description;
      } else {
        delete updates.description;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'assignee')) {
        const assignee = updates.assignee;
        const assigneeName =
          isRecord(assignee) && typeof assignee.name === 'string' ? assignee.name : undefined;
        if (assigneeName) {
          args.assignee = assigneeName;
        } else if (assignee === null) {
          args.assignee = null;
        }
        delete updates.assignee;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'parent')) {
        const parent = updates.parent;
        args.parent =
          isRecord(parent) && typeof parent.key === 'string' ? parent.key : null;
        delete updates.parent;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'priority')) {
        const priority = updates.priority;
        args.priority =
          isRecord(priority) && typeof priority.name === 'string' ? priority.name : undefined;
        delete updates.priority;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'issuetype')) {
        const issuetype = updates.issuetype;
        args.issueTypeName =
          isRecord(issuetype) && typeof issuetype.name === 'string' ? issuetype.name : undefined;
        delete updates.issuetype;
      }

      const remainingKeys = Object.keys(updates);
      if (remainingKeys.length > 0) {
        args.fields = { ...updates };
      }
      await this.callJsonTool(this.requireTool(tools, 'updateIssue'), args);
      return;
    }

    const fieldsArg: Record<string, unknown> = {};
    const additionalFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'parent' || key === 'priority' || key === 'issuetype') {
        additionalFields[key] = value;
        continue;
      }
      fieldsArg[key] = value;
    }

    const args = {
      issue_key: issueKey,
      fields: JSON.stringify(fieldsArg),
      additional_fields:
        Object.keys(additionalFields).length > 0 ? JSON.stringify(additionalFields) : undefined
    };
    await this.callJsonTool(COMMUNITY_TOOLS.updateIssue, args);
  }

  // ── Board helpers ─────────────────────────────────────────────────────────

  private async fetchAgileBoards(): Promise<Board[]> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    if (tools.adapter !== 'community' || !tools.names.has(COMMUNITY_TOOLS.getAgileBoards)) {
      return [];
    }

    const payload = await this.callJsonTool(COMMUNITY_TOOLS.getAgileBoards, {
      limit: 100,
      start_at: 0
    });
    const rawBoards = extractArray(payload, ['values', 'boards']);
    const boards: Board[] = [];
    for (const raw of rawBoards) {
      const board = this.toBoard(this.normalizeAgileBoard(raw));
      if (board) {
        boards.push(board);
      }
    }
    return boards;
  }

  private toBoard(entry: AgileBoardEntry | undefined): Board | undefined {
    if (!entry) {
      return undefined;
    }
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type ?? 'scrum',
      projectKey: entry.projectKey,
      projectName: entry.projectName,
      locationName: entry.locationName,
      raw: entry.raw
    };
  }

  private async fetchAgileBoardIssues(agileBoardId: string): Promise<IssueSummary[]> {
    await this.ensureConnected();
    const tools = this.requireResolved();
    if (tools.adapter !== 'community') {
      return [];
    }

    const jql = 'ORDER BY updated DESC';
    const payload = await this.callJsonTool(COMMUNITY_TOOLS.getBoardIssues, {
      board_id: agileBoardId,
      jql,
      limit: 100,
      start_at: 0
    });
    if (!isRecord(payload)) {
      return [];
    }

    const browseBase = this.getBrowseBaseUrl();
    const rawIssues = extractArray(payload, ['issues']);
    return rawIssues
      .map(issue => normalizeIssue(issue, browseBase))
      .filter((item): item is IssueSummary => Boolean(item));
  }

  private async fetchBoardWorkflowStatuses(
    issues: IssueSummary[]
  ): Promise<string[] | undefined> {
    const projectKey = this.resolveBoardProjectKey(issues);
    if (!projectKey) {
      return undefined;
    }
    const issueTypeNames = [
      ...new Set(
        issues
          .map(issue => issue.issueType.trim())
          .filter(issueType => issueType.length > 0)
      )
    ];
    if (issueTypeNames.length === 0) {
      return undefined;
    }

    const allowedIssueTypes = new Set(issueTypeNames.map(normalizeFieldName));
    const fromIssues = issues
      .map(issue => issue.status?.trim())
      .filter((statusName): statusName is string => Boolean(statusName));
    return buildBoardStatusOrder([], fromIssues, fromIssues);
  }

  private normalizeAgileBoard(raw: unknown): AgileBoardEntry | undefined {
    if (!isRecord(raw)) {
      return undefined;
    }
    const id = asString(raw.id);
    const name = asString(raw.name);
    if (!id || !name) {
      return undefined;
    }
    const location = isRecord(raw.location) ? raw.location : undefined;
    const projectKey = location ? asString(location.projectKey) : asString(raw.projectKey);
    const projectName = location ? asString(location.projectName) ?? asString(raw.projectName) : asString(raw.projectName);
    const locationName = location ? asString(location.name) : undefined;
    return {
      id,
      name,
      type: asString(raw.type),
      projectKey: projectKey?.trim() || undefined,
      projectName: projectName?.trim() || undefined,
      locationName: locationName?.trim() || undefined,
      raw
    };
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
    const searchText = filters.searchText.trim();
    if (searchText.length === 0) {
      return true;
    }
    const boardQuery = this.parseJqlBoardQuery(board) ?? '';
    const target = `${board.name} ${board.projectName ?? ''} ${boardQuery}`.toLowerCase();
    return target.includes(searchText.toLowerCase());
  }

  private resolveBoardProjectKey(issues: IssueSummary[]): string | undefined {
    return issues.find(issue => issue.projectKey.trim())?.projectKey;
  }

  private parseEpicKey(boardId: string): string | undefined {
    return boardId.startsWith('epic:') ? boardId.slice('epic:'.length) : undefined;
  }

  private parseAgileBoardId(board: Board): string | undefined {
    if (isRecord(board.raw)) {
      const rawId = asString(board.raw.agileBoardId)?.trim() || asString(board.raw.id)?.trim();
      if (rawId) {
        return rawId;
      }
    }
    return board.id.startsWith('epic:') || board.id === 'jql:workspace' || board.id.startsWith(CUSTOM_JQL_BOARD_PREFIX)
      ? undefined
      : board.id;
  }

  private parseJqlBoardQuery(board: Board): string | undefined {
    if (board.id === 'jql:workspace') {
      if (!isRecord(board.raw)) {
        return this.configStore.getJiraMcpBoardJql().trim() || undefined;
      }
      const jql = asString(board.raw.jql)?.trim();
      return jql || this.configStore.getJiraMcpBoardJql().trim() || undefined;
    }

    if (board.id.startsWith(CUSTOM_JQL_BOARD_PREFIX)) {
      const encoded = board.id.slice(CUSTOM_JQL_BOARD_PREFIX.length);
      if (!encoded) {
        return undefined;
      }
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }

    return undefined;
  }

  private buildJqlBoardName(jql: string): string {
    const compact = jql.replace(/\s+/g, ' ').trim();
    if (compact.length <= 56) {
      return compact;
    }
    return `${compact.slice(0, 55)}…`;
  }

  private buildLinkedEpicDescendantClause(epicKey: string): string {
    return `(parent = ${escapeJqlValue(epicKey)} OR "Epic Link" = ${escapeJqlValue(epicKey)})`;
  }

  private buildBoardJqlFromQuery(jql: string): string {
    const trimmed = jql.trim();
    if (!trimmed) {
      throw new Error('Jira board JQL cannot be empty.');
    }
    if (/\border\s+by\b/i.test(trimmed)) {
      return trimmed;
    }
    return `${trimmed} ORDER BY updated DESC`;
  }

  private resolveProjectScope(projectKeys: string[]): string[] {
    if (projectKeys.length > 0) {
      return projectKeys;
    }
    const defaultProjectKey = this.configStore.getJiraDefaultProjectKey().trim();
    return defaultProjectKey ? [defaultProjectKey] : [];
  }

  private buildIssueSearchJql(filters: IssueFilters): string {
    const clauses: string[] = [];
    const projectScope = this.resolveProjectScope(filters.projectKeys);
    if (projectScope.length > 0) {
      clauses.push(`project in (${projectScope.map(escapeJqlValue).join(', ')})`);
    }
    if (filters.statuses.length > 0) {
      clauses.push(`status in (${filters.statuses.map(escapeJqlValue).join(', ')})`);
    }
    if (filters.issueTypes.length > 0) {
      clauses.push(`issuetype in (${filters.issueTypes.map(escapeJqlValue).join(', ')})`);
    }
    if (filters.searchText.trim()) {
      clauses.push(`text ~ ${escapeJqlValue(escapeJqlText(filters.searchText.trim()))}`);
    }
    if (filters.assigneeMode === 'me') {
      clauses.push('assignee = currentUser()');
    }
    if (filters.parentKey?.trim()) {
      clauses.push(
        `(parent = ${escapeJqlValue(filters.parentKey.trim())} OR "Epic Link" = ${escapeJqlValue(filters.parentKey.trim())} OR key = ${escapeJqlValue(filters.parentKey.trim())})`
      );
    } else {
      const linkedEpicKey = this.configStore.getJiraMcpEpicKey().trim();
      if (linkedEpicKey) {
        clauses.push(this.buildLinkedEpicDescendantClause(linkedEpicKey));
      }
    }
    return clauses.join(' AND ');
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
}

function operationToAtlassianKey(
  operation: keyof typeof COMMUNITY_TOOLS
): string | undefined {
  switch (operation) {
    case 'listProjects':
      return ATLASSIAN_TOOLS.listProjects;
    case 'search':
      return ATLASSIAN_TOOLS.search;
    case 'createIssue':
      return ATLASSIAN_TOOLS.createIssue;
    case 'updateIssue':
      return ATLASSIAN_TOOLS.updateIssue;
    case 'deleteIssue':
      return ATLASSIAN_TOOLS.deleteIssue;
    case 'getIssue':
      return ATLASSIAN_TOOLS.getIssue;
    case 'addComment':
      return ATLASSIAN_TOOLS.addComment;
    case 'getTransitions':
      return ATLASSIAN_TOOLS.getTransitions;
    default:
      return undefined;
  }
}
