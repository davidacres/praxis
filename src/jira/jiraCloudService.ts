import * as vscode from 'vscode';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { AppConfigStore } from '../config/jiraConfig';
import { initializeJiraCloudOAuthService, type JiraCloudOAuthService } from './jiraCloudOAuthService';
import type {
  BackendMode,
  Board,
  BoardColumn,
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
  ParentIssueReference,
  IssueSummary,
  PagedIssues,
  Project,
  SubTaskSummary,
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

interface JiraCloudUser {
  displayName?: string;
  name?: string;
  key?: string;
  accountId?: string;
}

function normalizeUserDisplayName(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  return asString(raw.displayName) ?? asString(raw.name) ?? asString(raw.key);
}

function buildJiraMention(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const accountId = asString(raw.accountId)?.trim();
  if (accountId) {
    return `[~accountid:${accountId}]`;
  }

  const userName = asString(raw.name)?.trim() || asString(raw.key)?.trim();
  if (userName) {
    return `[~${userName}]`;
  }

  return undefined;
}

interface JiraCloudFieldIds {
  epicLinkFieldId?: string;
  epicLinkFieldName?: string;
  epicNameFieldId?: string;
}

interface JiraCloudSearchResult {
  issues: IssueSummary[];
  total: number;
  rawIssues: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

interface JiraAgileBoardColumnStatus {
  id?: string;
  name?: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeFieldName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replaceAll(/[\s_-]+/g, ' ');
}

function normalizeWorkflowIssueTypeName(value: string | undefined): string {
  return normalizeFieldName(value);
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

function isBacklogStatusName(statusName: string | undefined): boolean {
  return normalizeFieldName(statusName) === 'backlog';
}

const CUSTOM_JQL_BOARD_PREFIX = 'jql:custom:';

export function resolveBoardWorkflowStatusOrder(
  boardConfiguredStatuses: string[],
  workflowStatuses: string[],
  issueStatuses: string[]
): string[] {
  if (boardConfiguredStatuses.length > 0) {
    return [...boardConfiguredStatuses];
  }

  const orderedStatuses: string[] = [];
  const seen = new Set<string>();
  const backlogStatus = [...workflowStatuses, ...issueStatuses].find(statusName =>
    isBacklogStatusName(statusName)
  );

  if (backlogStatus) {
    appendUniqueStatusName(orderedStatuses, seen, backlogStatus);
  }

  for (const statusName of workflowStatuses) {
    appendUniqueStatusName(orderedStatuses, seen, statusName);
  }

  for (const statusName of issueStatuses) {
    appendUniqueStatusName(orderedStatuses, seen, statusName);
  }

  return orderedStatuses;
}

function escapeJqlValue(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

function escapeJqlText(value: string): string {
  return value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function deriveBrowseUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, '')}/browse/${key}`;
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

  const joined = parts.join(' ').replaceAll(/\s+/g, ' ').trim();
  return joined.length > 0 ? joined : undefined;
}

interface JiraRawResponse {
  status: number;
  statusText: string;
  contentType?: string;
  bodyText: string;
}

interface JiraBinaryResponse {
  status: number;
  statusText: string;
  contentType?: string;
  body: Buffer;
}

type ConnectionError = Error & {
  code?: string;
  isConnectionError?: boolean;
};

function resolvePort(url: URL, isHttps: boolean): number {
  if (url.port) {
    return Number(url.port);
  }

  return isHttps ? 443 : 80;
}

function isPrivateTenNetAddress(address: string): boolean {
  if (net.isIP(address) !== 4) {
    return false;
  }

  return address.split('.')[0] === '10';
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const addresses = await dns.lookup(hostname, {
    all: true,
    family: 4,
    order: 'verbatim'
  });

  return addresses.map(entry => entry.address);
}

async function resolveInternalCandidateIps(
  internalDns: string,
  preferredResolveIp: string
): Promise<string[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const trimmedPreferredIp = preferredResolveIp.trim();

  if (net.isIP(trimmedPreferredIp) === 4) {
    candidates.push(trimmedPreferredIp);
    seen.add(trimmedPreferredIp);
  }

  const resolvedIps = await defaultResolveAddresses(internalDns);
  for (const resolvedIp of resolvedIps) {
    if (!isPrivateTenNetAddress(resolvedIp) || seen.has(resolvedIp)) {
      continue;
    }

    candidates.push(resolvedIp);
    seen.add(resolvedIp);
  }

  if (candidates.length === 0) {
    throw new Error(`No private IPv4 Jira addresses could be resolved from ${internalDns}.`);
  }

  return candidates;
}

function asConnectionError(error: unknown): ConnectionError {
  if (error instanceof Error) {
    return error as ConnectionError;
  }

  return new Error(String(error)) as ConnectionError;
}

function markConnectionError(error: unknown): ConnectionError {
  const connectionError = asConnectionError(error);
  connectionError.isConnectionError = true;
  return connectionError;
}

function isConnectionError(error: unknown): error is ConnectionError {
  return asConnectionError(error).isConnectionError === true;
}

function getResponseSnippet(text: string, maxLength = 200): string | undefined {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function buildNonJsonJiraResponseMessage(
  status: number,
  statusText: string,
  contentType: string | undefined,
  bodyText: string
): string {
  const snippet = getResponseSnippet(bodyText);
  const normalizedContentType = contentType?.split(';', 1)[0]?.trim() || 'unknown';
  const prefix = `${status} ${statusText}`.trim();
  if (!snippet) {
    return `${prefix}. Jira returned non-JSON content (${normalizedContentType}).`;
  }

  return `${prefix}. Jira returned non-JSON content (${normalizedContentType}): ${snippet}`;
}

function tryParseJsonResponse(text: string, contentType: string | undefined): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalizedContentType = contentType?.toLowerCase() ?? '';
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksLikeJson && normalizedContentType && !normalizedContentType.includes('json')) {
    return undefined;
  }

  return JSON.parse(trimmed) as JsonValue;
}

function extractJiraErrorMessage(
  value: unknown,
  status: number,
  statusText: string,
  bodyText?: string,
  contentType?: string
): string {
  if (isRecord(value)) {
    const errorMessages = toArray(value.errorMessages)
      .map(asString)
      .filter((item): item is string => Boolean(item));
    const errors = isRecord(value.errors)
      ? Object.entries(value.errors)
          .map(([, entry]) => asString(entry))
          .filter((item): item is string => Boolean(item))
      : [];
    const details = [...errorMessages, ...errors].join(' ');
    if (details) {
      return details;
    }

    const message =
      asString(value.message) ??
      asString(value.errorMessage) ??
      asString(value.error_description) ??
      asString(value.error);
    if (message) {
      const code = asString(value.code);
      return code ? `${code}: ${message}` : message;
    }
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (bodyText && bodyText.trim().length > 0) {
    return buildNonJsonJiraResponseMessage(status, statusText, contentType, bodyText);
  }

  return `${status} ${statusText}`.trim();
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
    : asString(fields.issuetype);

  return {
    key,
    summary: asString(fields.summary),
    issueType,
    description: extractDescription(fields.description)
  };
}

function normalizeIssue(raw: unknown, baseUrl: string): IssueSummary | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const project = isRecord(fields.project) ? fields.project : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const issueType = isRecord(fields.issuetype) ? fields.issuetype : {};
  const parent = isRecord(fields.parent) ? fields.parent : {};
  const assignee = isRecord(fields.assignee) ? fields.assignee : {};
  const reporter = isRecord(fields.reporter) ? fields.reporter : {};
  const priority = isRecord(fields.priority) ? fields.priority : {};
  const key = asString(raw.key);

  if (!key) {
    return undefined;
  }

  return {
    id: asString(raw.id),
    key,
    summary: asString(fields.summary) ?? '(No summary)',
    status: asString(status.name) ?? asString(fields.status) ?? 'Unknown',
    statusCategory: isRecord(status.statusCategory)
      ? asString(status.statusCategory.name)
      : undefined,
    issueType: asString(issueType.name) ?? asString(fields.issuetype) ?? 'Issue',
    projectKey: asString(project.key) ?? '',
    projectName: asString(project.name),
    parentKey: asString(parent.key),
    parentIssue: normalizeParentIssue(parent),
    assignee: normalizeUserDisplayName(assignee),
    reporter: normalizeUserDisplayName(reporter),
    reporterMention: buildJiraMention(reporter),
    priority: asString(priority.name),
    created: asString(fields.created),
    updated: asString(fields.updated),
    selfUrl: asString(raw.self),
    browseUrl: deriveBrowseUrl(baseUrl, key),
    description: extractDescription(fields.description),
    raw
  };
}

function normalizeTransition(raw: unknown): WorkflowTransition | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const to = isRecord(raw.to) ? raw.to : {};
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) {
    return undefined;
  }
  return {
    id,
    name,
    toStatus: asString(to.name),
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

function normalizeAttachment(raw: unknown): IssueAttachment | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const fileName = asString(raw.filename) ?? asString(raw.fileName);
  if (!fileName?.trim()) {
    return undefined;
  }

  const author = isRecord(raw.author) ? raw.author : {};
  const sizeValue = typeof raw.size === 'number'
    ? raw.size
    : typeof raw.size === 'string'
      ? Number(raw.size)
      : undefined;

  return {
    id: asString(raw.id),
    fileName: fileName.trim(),
    mimeType: asString(raw.mimeType),
    sizeBytes: typeof sizeValue === 'number' && Number.isFinite(sizeValue) ? sizeValue : undefined,
    contentUrl: asString(raw.content),
    thumbnailUrl: asString(raw.thumbnail),
    created: asString(raw.created),
    author: asString(author.displayName) ?? asString(author.name),
    raw
  };
}

function statusCategoryRank(statusCategory: string | undefined): number {
  const normalized = (statusCategory ?? '').trim().toLowerCase();
  if (normalized === 'to do' || normalized === 'todo') {
    return 0;
  }
  if (normalized === 'in progress' || normalized === 'indeterminate') {
    return 1;
  }
  if (normalized === 'done') {
    return 2;
  }
  return 3;
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

export class JiraCloudService implements IssueTrackerService {
  public readonly mode: BackendMode = 'jiracloud';

  private cachedProjects?: Project[];
  private fieldIds?: JiraCloudFieldIds;
  private currentUser?: JiraCloudUser;
  private readonly oauthService: JiraCloudOAuthService;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore,
    private readonly output: vscode.OutputChannel
  ) {
    this.oauthService = initializeJiraCloudOAuthService(context, configStore);
  }

  public getDefaultPageSize(): number {
    return this.configStore.getDefaultPageSize();
  }

  public async reset(): Promise<void> {
    this.cachedProjects = undefined;
    this.fieldIds = undefined;
    this.currentUser = undefined;
  }

  public async checkConnection(): Promise<ConnectionCheck> {
    if (!this.configStore.hasJiraCloudConfig()) {
      return {
        status: 'error',
        message: 'No Jira Cloud connection is configured.',
        toolCount: 0
      };
    }

    try {
      await this.getCurrentUser();
      const projects = await this.getProjects(true);
      return {
        status: projects.length === 0 ? 'warning' : 'ok',
        message:
          projects.length === 0
            ? 'Connected, but no Jira projects are accessible.'
            : `Connected. ${projects.length} accessible project(s) found.`,
        toolCount: 1,
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

    const response = await this.requestJson('GET', '/rest/api/2/project');
    const items = toArray(response)
      .map(normalizeProject)
      .filter((item): item is Project => Boolean(item))
      .sort((left, right) => left.key.localeCompare(right.key));
    this.cachedProjects = items;
    return items;
  }

  public async getIssues(
    filters: IssueFilters,
    startAt: number,
    pageSize: number
  ): Promise<PagedIssues> {
    const boardScopedIssues = await this.getBoardScopedIssues(filters);
    if (boardScopedIssues) {
      const filtered = await this.filterIssuesForSidebar(boardScopedIssues, filters);
      const pageIssues = filtered.slice(startAt, startAt + pageSize);
      return {
        issues: pageIssues,
        total: filtered.length,
        hasMore: startAt + pageIssues.length < filtered.length
      };
    }

    const search = await this.searchIssues(
      this.buildIssueSearchJql(filters),
      [
        'summary',
        'status',
        'issuetype',
        'assignee',
        'priority',
        'updated',
        'project',
        'description',
        'parent'
      ],
      startAt,
      pageSize
    );
    return {
      issues: search.issues,
      total: search.total,
      hasMore: startAt + search.issues.length < search.total
    };
  }

  public async getFilterMetadata(filters: IssueFilters): Promise<FilterMetadata> {
    const boardScopedIssues = await this.getBoardScopedIssues(filters);
    if (boardScopedIssues) {
      const filtered = await this.filterIssuesForSidebar(boardScopedIssues, {
        ...filters,
        statuses: [],
        issueTypes: [],
        searchText: '',
        parentKey: undefined
      });
      return {
        statuses: [...new Set(filtered.map(issue => issue.status))].sort((a, b) => a.localeCompare(b)),
        issueTypes: [...new Set(filtered.map(issue => issue.issueType))].sort((a, b) => a.localeCompare(b))
      };
    }

    const search = await this.searchIssues(
      this.buildIssueSearchJql({
        ...filters,
        statuses: [],
        issueTypes: [],
        searchText: '',
        parentKey: undefined
      }),
      ['status', 'issuetype', 'project'],
      0,
      200
    );
    return {
      statuses: [...new Set(search.issues.map(issue => issue.status))].sort((a, b) => a.localeCompare(b)),
      issueTypes: [...new Set(search.issues.map(issue => issue.issueType))].sort((a, b) => a.localeCompare(b))
    };
  }

  public async getParentItems(
    filters: IssueFilters,
    searchText?: string,
    options?: ParentItemQueryOptions
  ): Promise<IssueSummary[]> {
    const allowedParentTypes = options?.childIssueType
      ? getParentRule(options.childIssueType, this.mode).allowedParentTypes
      : ['Epic'];
    if (allowedParentTypes.length === 0) {
      return [];
    }

    const boardScopedIssues = await this.getBoardScopedIssues(filters);
    if (boardScopedIssues) {
      const parentTypeSet = new Set(allowedParentTypes.map(value => value.trim().toLowerCase()));
      const normalizedSearchText = searchText?.trim().toLowerCase();
      return boardScopedIssues
        .filter(issue => parentTypeSet.has(issue.issueType.trim().toLowerCase()))
        .filter(issue =>
          filters.statuses.length === 0 ||
          filters.statuses.some(status => status.trim().toLowerCase() === issue.status.trim().toLowerCase())
        )
        .filter(issue => {
          if (!normalizedSearchText) {
            return true;
          }
          const target = `${issue.key} ${issue.summary} ${issue.description ?? ''}`.toLowerCase();
          return target.includes(normalizedSearchText);
        })
        .sort((left, right) => {
          const leftUpdated = left.updated ? Date.parse(left.updated) : 0;
          const rightUpdated = right.updated ? Date.parse(right.updated) : 0;
          return rightUpdated - leftUpdated;
        })
        .slice(0, 50);
    }

    const clauses = [`issuetype in (${allowedParentTypes.map(escapeJqlValue).join(', ')})`];
    const projectScope = this.resolveProjectScope(filters.projectKeys);
    if (projectScope.length > 0) {
      clauses.push(`project in (${projectScope.map(escapeJqlValue).join(', ')})`);
    }
    if (filters.statuses.length > 0) {
      clauses.push(`status in (${filters.statuses.map(escapeJqlValue).join(', ')})`);
    }
    if (searchText?.trim()) {
      clauses.push(`text ~ ${escapeJqlValue(escapeJqlText(searchText.trim()))}`);
    }
    const search = await this.searchIssues(
      `${clauses.join(' AND ')} ORDER BY updated DESC`,
      ['summary', 'status', 'issuetype', 'project', 'description', 'updated'],
      0,
      50
    );
    return search.issues;
  }

  public async supportsBoards(): Promise<boolean> {
    return true;
  }

  public async getBoards(filters: BoardFilters): Promise<Board[]> {
    const boards: Board[] = [];
    let agileLoadError: string | undefined;
    try {
      boards.push(...(await this.fetchAgileBoards()));
    } catch (error) {
      agileLoadError = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[jiracloud] Failed to load Jira Cloud boards: ${agileLoadError}`);
    }

    const linkedEpicKey = this.getLinkedEpicKey();
    const linkedBoardJql = this.getLinkedBoardJql();

    if (linkedEpicKey) {
      try {
        const epic = await this.getIssue(linkedEpicKey);
        boards.push({
          id: `epic:${epic.key}`,
          name: this.getLinkedEpicBoardName() || `${epic.key} ${epic.summary}`,
          type: 'epic',
          projectKey: epic.projectKey,
          projectName: epic.projectName,
          locationName: epic.projectName,
          raw: { epicKey: epic.key }
        });
      } catch (error) {
        this.output.appendLine(
          `[jiracloud] Failed to load linked epic board ${linkedEpicKey}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (linkedBoardJql) {
      boards.push({
        id: 'jql:workspace',
        name: this.getLinkedBoardName() || this.buildJqlBoardName(linkedBoardJql),
        type: 'jql',
        raw: { jql: linkedBoardJql }
      });
    }

    if (agileLoadError) {
      throw new Error(
        `Could not load Jira Cloud Agile boards: ${agileLoadError}. Ensure your OAuth token includes scope 'read:board-scope:jira-software'. You can still use linked epic/JQL boards or add custom JQL boards.`
      );
    }

    return boards.filter(board => this.matchesBoardFilters(board, filters));
  }

  public async getBoardDetails(board: Board): Promise<BoardDetails> {
    const agileBoardId = this.parseAgileBoardId(board);
    if (agileBoardId) {
      const issues = sortIssuesByUpdated(await this.fetchAgileBoardIssues(agileBoardId));
      const columnStatusOrder = await this.fetchBoardWorkflowStatuses(board, issues);
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
      jql = this.buildBoardJql(epicKey);
    } else {
      const boardJql = this.parseJqlBoardQuery(board);
      if (!boardJql) {
        throw new Error('Invalid Jira Cloud board identifier.');
      }
      jql = this.buildBoardJqlFromQuery(boardJql);
    }

    const search = await this.searchAllIssues(
      jql,
      ['summary', 'status', 'issuetype', 'assignee', 'priority', 'updated', 'project', 'description', 'parent']
    );
    const issues = sortIssuesByUpdated(search.issues);
    const columnStatusOrder = await this.fetchBoardWorkflowStatuses(board, issues);
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
    await this.searchIssues(
      this.buildBoardJqlFromQuery(trimmedJql),
      ['key'],
      0,
      1
    );
  }

  public async createBoard(_input: CreateBoardInput): Promise<Board> {
    throw new Error('Creating boards is not supported in Jira Cloud mode. Boards are derived from the linked epic or configured JQL query.');
  }

  public async updateBoard(_boardId: string, _input: UpdateBoardInput): Promise<Board> {
    const inputName = _input.name?.trim();
    const inputJql = _input.jql?.trim();
    if (!inputName) {
      throw new Error('Board name cannot be empty.');
    }

    if (_boardId.startsWith('epic:')) {
      if (inputJql && inputJql.length > 0) {
        throw new Error('Epic boards do not support a custom JQL query.');
      }
      const epicKey = this.parseEpicKey(_boardId);
      if (!epicKey) {
        throw new Error('Invalid Jira Cloud board identifier.');
      }
      const epic = await this.getIssue(epicKey);
      await this.configStore.setJiraCloudEpicBoardName(inputName);
      return {
        id: _boardId,
        name: inputName,
        type: 'epic',
        projectKey: epic.projectKey,
        projectName: epic.projectName,
        locationName: epic.projectName,
        raw: { epicKey: epic.key }
      };
    }

    if (_boardId === 'jql:workspace') {
      const boardJql = this.getLinkedBoardJql();
      if (!boardJql) {
        throw new Error('Jira Cloud board query is not configured.');
      }
      if (inputJql !== undefined) {
        if (!inputJql) {
          throw new Error('Board JQL cannot be empty.');
        }
        await this.configStore.setJiraCloudBoardJql(inputJql);
      }
      await this.configStore.setJiraCloudBoardName(inputName);
      return {
        id: _boardId,
        name: inputName,
        type: 'jql',
        raw: { jql: inputJql || boardJql }
      };
    }

    throw new Error('Boards cannot be edited in Jira Cloud mode.');
  }

  public async deleteBoard(_boardId: string): Promise<void> {
    throw new Error('Boards cannot be deleted in Jira Cloud mode.');
  }

  public async getIssue(issueKey: string): Promise<IssueDetails> {
    const fieldIds = await this.getFieldIds();
    const fields = [
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
      'attachment'
    ];
    if (fieldIds.epicLinkFieldId) {
      fields.push(fieldIds.epicLinkFieldId);
    }
    const response = await this.requestJson(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields.join(','))}`
    );
    const issue = normalizeIssue(response, this.getBrowseBaseUrl());
    if (!issue) {
      throw new Error(`Unable to load details for ${issueKey}.`);
    }
    const fieldsObject = isRecord(response) && isRecord(response.fields) ? response.fields : {};
    const comments = isRecord(fieldsObject.comment)
      ? toArray(fieldsObject.comment.comments)
          .map(normalizeComment)
          .filter((item): item is IssueComment => Boolean(item))
      : [];
    const attachments = toArray(fieldsObject.attachment)
      .map(normalizeAttachment)
      .filter((item): item is IssueAttachment => Boolean(item));
    return {
      ...issue,
      comments,
      attachments
    };
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetails> {
    const issueType = input.issueType.trim();
    if (!issueType) {
      throw new Error('Issue type cannot be empty.');
    }

    const parentKey = input.parentKey?.trim() || undefined;
    await this.validateParentSelection(input.projectKey, issueType, parentKey);
    const fieldIds = await this.getFieldIds();
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary.trim(),
      issuetype: { name: issueType },
      description: input.description
    };

    if (issueType === 'Epic' && fieldIds.epicNameFieldId) {
      fields[fieldIds.epicNameFieldId] = input.summary.trim().slice(0, 255);
    }

    if (parentKey) {
      if (isSubtaskIssueType(issueType)) {
        fields.parent = { key: parentKey };
      } else {
        if (!fieldIds.epicLinkFieldId) {
          throw new Error('Epic Link field was not found in Jira. Child issues cannot be attached to an epic in Jira Cloud mode.');
        }
        fields[fieldIds.epicLinkFieldId] = parentKey;
      }
    }

    const response = await this.requestJson('POST', '/rest/api/2/issue', { fields });
    const createdKey = isRecord(response) ? asString(response.key) : undefined;
    if (!createdKey) {
      throw new Error('Jira did not return the created issue key.');
    }
    return this.getIssue(createdKey);
  }

  public async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<IssueDetails> {
    const current = await this.getIssue(issueKey);
    const nextIssueType =
      typeof input.issueType === 'string' && input.issueType.trim().length > 0
        ? input.issueType.trim()
        : current.issueType;
    const hasParentPatch = Object.prototype.hasOwnProperty.call(input, 'parentKey');
    const nextParentKey = hasParentPatch ? input.parentKey?.trim() || undefined : current.parentKey;
    await this.validateParentSelection(current.projectKey, nextIssueType, nextParentKey, issueKey);
    const fieldIds = await this.getFieldIds();
    const fields: Record<string, unknown> = {};

    if (typeof input.summary === 'string') {
      const summary = input.summary.trim();
      if (!summary) {
        throw new Error('Summary cannot be empty.');
      }
      fields.summary = summary;
      if (nextIssueType === 'Epic' && fieldIds.epicNameFieldId) {
        fields[fieldIds.epicNameFieldId] = summary.slice(0, 255);
      }
    }
    if (typeof input.description === 'string') {
      fields.description = input.description;
    }
    if (typeof input.priority === 'string') {
      fields.priority = { name: input.priority.trim() };
    }
    if (typeof input.issueType === 'string') {
      fields.issuetype = { name: nextIssueType };
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      fields.assignee = input.assignee?.trim() ? { name: input.assignee.trim() } : null;
    }
    if (hasParentPatch) {
      if (isParentIssueType(nextIssueType)) {
        if (fieldIds.epicLinkFieldId) {
          fields[fieldIds.epicLinkFieldId] = null;
        }
        fields.parent = null;
      } else if (isSubtaskIssueType(nextIssueType)) {
        fields.parent = nextParentKey ? { key: nextParentKey } : null;
        if (fieldIds.epicLinkFieldId) {
          fields[fieldIds.epicLinkFieldId] = null;
        }
      } else {
        fields.parent = null;
        if (!fieldIds.epicLinkFieldId) {
          throw new Error('Epic Link field was not found in Jira.');
        }
        fields[fieldIds.epicLinkFieldId] = nextParentKey ?? null;
      }
    }

    await this.requestJson('PUT', `/rest/api/2/issue/${encodeURIComponent(issueKey)}`, { fields });
    return this.getIssue(issueKey);
  }

  public async deleteIssue(issueKey: string): Promise<void> {
    await this.requestJson('DELETE', `/rest/api/2/issue/${encodeURIComponent(issueKey)}`);
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error('Comment cannot be empty.');
    }
    await this.requestJson('POST', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: trimmed
    });
  }

  public async attachFile(issueKey: string, filePath: string, fileName?: string): Promise<void> {
    const attachmentName = fileName?.trim() || path.basename(filePath);
    const bytes = await fs.readFile(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([bytes]), attachmentName);
    await this.requestMultipart(
      'POST',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
      formData
    );
  }

  public async downloadAttachment(
    _issueKey: string,
    attachment: IssueAttachment,
    targetFilePath: string
  ): Promise<void> {
    const contentUrl = attachment.contentUrl?.trim();
    if (!contentUrl) {
      throw new Error(`Attachment ${attachment.fileName} does not have a downloadable content URL.`);
    }

    const bytes = await this.requestBinary(contentUrl);
    await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
    await fs.writeFile(targetFilePath, bytes);
  }

  public async getTransitions(issueKey: string): Promise<WorkflowTransition[]> {
    const response = await this.requestJson(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    return (isRecord(response) ? toArray(response.transitions) : [])
      .map(normalizeTransition)
      .filter((item): item is WorkflowTransition => Boolean(item));
  }

  public async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
      { transition: { id: transitionId } }
    );
  }

  public async getBrowseUrl(issue: IssueSummary): Promise<string | undefined> {
    return issue.browseUrl ?? deriveBrowseUrl(this.getBrowseBaseUrl(), issue.key);
  }

  public async getSelfAssigneeLabel(): Promise<string | undefined> {
    const user = await this.getCurrentUser();
    return user.displayName ?? user.name;
  }

  /**
   * Fetch sub-tasks for a given parent issue.
   * Uses JQL to find issues whose parent is the given key.
   */
  public async getSubTasks(parentKey: string): Promise<SubTaskSummary[]> {
    const jql = `parent = ${parentKey} ORDER BY rank ASC, key ASC`;
    const response = await this.requestJson(
      'POST',
      '/rest/api/3/search/jql',
      { jql, maxResults: 100, fields: ['summary', 'status', 'issuetype', 'assignee'] }
    );
    if (!isRecord(response)) {
      return [];
    }
    const issues = toArray(response.issues);
    const results: SubTaskSummary[] = [];
    for (const raw of issues) {
      if (!isRecord(raw)) {
        continue;
      }
      const key = asString(raw.key);
      if (!key) {
        continue;
      }
      const f = isRecord(raw.fields) ? raw.fields : raw;
      const status = isRecord(f.status) ? f.status : {};
      const issueType = isRecord(f.issuetype) ? f.issuetype : {};
      const assignee = isRecord(f.assignee) ? f.assignee : {};
      results.push({
        key,
        summary: asString(f.summary) ?? '(No summary)',
        status: asString(status.name) ?? 'Unknown',
        statusCategory: isRecord(status.statusCategory)
          ? asString(status.statusCategory.name)
          : undefined,
        issueType: asString(issueType.name) ?? 'Task',
        assignee: asString(assignee.displayName) ?? asString(assignee.name)
      });
    }
    return results;
  }

  /**
   * Create multiple sub-tasks linked to a parent issue in a single call sequence.
   * Returns the created issue keys in order.
   */
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
    return createdKeys;
  }

  public dispose(): void {
    void this.reset();
  }

  private getBrowseBaseUrl(): string {
    const value = this.configStore.getJiraCloudSiteUrl().trim();
    if (!value) {
      throw new Error('No Jira Cloud site is selected.');
    }
    return value.replace(/\/$/, '');
  }

  private getCloudApiBaseUrl(): string {
    return this.oauthService.getCloudApiBaseUrl().replace(/\/$/, '');
  }

  private async getCloudAuthHeaders(): Promise<Record<string, string>> {
    return {
      ...(await this.getCloudBaseAuthHeaders()),
      'Content-Type': 'application/json'
    };
  }

  private async getCloudBaseAuthHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.oauthService.getAccessToken()}`,
      Accept: 'application/json'
    };
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      ...this.getBaseAuthHeaders(),
      'Content-Type': 'application/json'
    };
  }

  private getBaseAuthHeaders(): Record<string, string> {
    throw new Error('Internal Jira routing is not used for Jira Cloud.');
  }

  private shouldUseInternalRouting(baseUrl: URL): boolean {
    const internalDns = this.configStore.getJiraCloudInternalDns().trim();
    if (!internalDns) {
      return false;
    }

    try {
      const defaultBaseUrl = new URL(this.configStore.getJiraDefaultBaseUrl());
      return baseUrl.hostname.toLowerCase() === defaultBaseUrl.hostname.toLowerCase();
    } catch {
      return false;
    }
  }

  private async requestJsonDirect(method: string, url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configStore.getRequestTimeoutMs());
    try {
      const response = await fetch(url, {
        method,
        headers: await this.getCloudAuthHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? undefined;
      const parsed = tryParseJsonResponse(text, contentType);
      if (!response.ok) {
        throw new Error(
          extractJiraErrorMessage(parsed, response.status, response.statusText, text, contentType)
        );
      }
      if (text.trim().length > 0 && parsed === undefined) {
        throw new Error(
          buildNonJsonJiraResponseMessage(response.status, response.statusText, contentType, text)
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Jira Cloud request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestMultipartDirect(
    method: string,
    url: string,
    body: Buffer,
    contentType: string
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configStore.getRequestTimeoutMs());
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(await this.getCloudBaseAuthHeaders()),
          'X-Atlassian-Token': 'no-check',
          'Content-Type': contentType
        },
        body,
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = tryParseJsonResponse(text, response.headers.get('content-type') ?? undefined);
      if (!response.ok) {
        throw new Error(
          extractJiraErrorMessage(
            parsed,
            response.status,
            response.statusText,
            text,
            response.headers.get('content-type') ?? undefined
          )
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Jira Cloud request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestBinaryDirect(method: string, url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configStore.getRequestTimeoutMs());
    try {
      const response = await fetch(url, {
        method,
        headers: await this.getCloudBaseAuthHeaders(),
        signal: controller.signal
      });
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? undefined;
      if (!response.ok) {
        const text = body.toString('utf8');
        const parsed = tryParseJsonResponse(text, contentType);
        throw new Error(
          extractJiraErrorMessage(parsed, response.status, response.statusText, text, contentType)
        );
      }
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Jira Cloud request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestRawViaCandidate(
    method: string,
    baseUrl: URL,
    requestPath: string,
    body: unknown,
    candidateIp: string
  ): Promise<JiraRawResponse> {
    const isHttps = baseUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = this.configStore.getRequestTimeoutMs();
    const requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const requestOptions: https.RequestOptions = {
      protocol: baseUrl.protocol,
      hostname: candidateIp,
      port: resolvePort(baseUrl, isHttps),
      path: requestPath,
      method,
      family: net.isIP(candidateIp) === 6 ? 6 : 4,
      timeout: timeoutMs,
      agent: false,
      headers: {
        ...this.getAuthHeaders(),
        ...(requestBody ? { 'Content-Length': String(requestBody.length) } : {}),
        host: baseUrl.host
      },
      lookup(_hostname, _options, callback) {
        callback(null, candidateIp, net.isIP(candidateIp));
      }
    };

    if (isHttps) {
      requestOptions.servername = baseUrl.hostname;
    }

    return await new Promise<JiraRawResponse>((resolve, reject) => {
      const request = transport.request(requestOptions, response => {
        let bodyText = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          bodyText += chunk;
        });
        response.on('end', () => {
          const rawContentType = response.headers['content-type'];
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            contentType: Array.isArray(rawContentType) ? rawContentType[0] : rawContentType,
            bodyText
          });
        });
        response.on('error', reject);
      });

      request.on('timeout', () => {
        const timeoutError = markConnectionError(
          new Error(`Jira Cloud request to ${candidateIp} timed out after ${timeoutMs} ms.`)
        );
        timeoutError.code = 'ETIMEDOUT';
        request.destroy(timeoutError);
      });

      request.on('error', error => {
        reject(markConnectionError(error));
      });

      if (requestBody) {
        request.write(requestBody);
      }
      request.end();
    });
  }

  private async requestMultipartViaCandidate(
    method: string,
    baseUrl: URL,
    requestPath: string,
    body: Buffer,
    contentType: string,
    candidateIp: string
  ): Promise<JiraRawResponse> {
    const isHttps = baseUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = this.configStore.getRequestTimeoutMs();
    const requestOptions: https.RequestOptions = {
      protocol: baseUrl.protocol,
      hostname: candidateIp,
      port: resolvePort(baseUrl, isHttps),
      path: requestPath,
      method,
      family: net.isIP(candidateIp) === 6 ? 6 : 4,
      timeout: timeoutMs,
      agent: false,
      headers: {
        ...this.getBaseAuthHeaders(),
        'X-Atlassian-Token': 'no-check',
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        host: baseUrl.host
      },
      lookup(_hostname, _options, callback) {
        callback(null, candidateIp, net.isIP(candidateIp));
      }
    };

    if (isHttps) {
      requestOptions.servername = baseUrl.hostname;
    }

    return await new Promise<JiraRawResponse>((resolve, reject) => {
      const request = transport.request(requestOptions, response => {
        let bodyText = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          bodyText += chunk;
        });
        response.on('end', () => {
          const rawContentType = response.headers['content-type'];
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            contentType: Array.isArray(rawContentType) ? rawContentType[0] : rawContentType,
            bodyText
          });
        });
        response.on('error', reject);
      });

      request.on('timeout', () => {
        const timeoutError = markConnectionError(
          new Error(`Jira Cloud request to ${candidateIp} timed out after ${timeoutMs} ms.`)
        );
        timeoutError.code = 'ETIMEDOUT';
        request.destroy(timeoutError);
      });

      request.on('error', error => {
        reject(markConnectionError(error));
      });

      request.write(body);
      request.end();
    });
  }

  private async requestBinaryViaCandidate(
    method: string,
    baseUrl: URL,
    requestPath: string,
    candidateIp: string
  ): Promise<JiraBinaryResponse> {
    const isHttps = baseUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = this.configStore.getRequestTimeoutMs();
    const requestOptions: https.RequestOptions = {
      protocol: baseUrl.protocol,
      hostname: candidateIp,
      port: resolvePort(baseUrl, isHttps),
      path: requestPath,
      method,
      family: net.isIP(candidateIp) === 6 ? 6 : 4,
      timeout: timeoutMs,
      agent: false,
      headers: {
        ...this.getBaseAuthHeaders(),
        host: baseUrl.host
      },
      lookup(_hostname, _options, callback) {
        callback(null, candidateIp, net.isIP(candidateIp));
      }
    };

    if (isHttps) {
      requestOptions.servername = baseUrl.hostname;
    }

    return await new Promise<JiraBinaryResponse>((resolve, reject) => {
      const request = transport.request(requestOptions, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const rawContentType = response.headers['content-type'];
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            contentType: Array.isArray(rawContentType) ? rawContentType[0] : rawContentType,
            body: Buffer.concat(chunks)
          });
        });
        response.on('error', reject);
      });

      request.on('timeout', () => {
        const timeoutError = markConnectionError(
          new Error(`Jira Cloud request to ${candidateIp} timed out after ${timeoutMs} ms.`)
        );
        timeoutError.code = 'ETIMEDOUT';
        request.destroy(timeoutError);
      });

      request.on('error', error => {
        reject(markConnectionError(error));
      });

      request.end();
    });
  }

  private async requestJsonViaInternalRouting(
    method: string,
    baseUrl: URL,
    requestPath: string,
    body?: unknown
  ): Promise<unknown> {
    const candidateIps = await resolveInternalCandidateIps(
      this.configStore.getJiraCloudInternalDns(),
      this.configStore.getJiraCloudPreferredResolveIp()
    );
    const failures: ConnectionError[] = [];

    for (const candidateIp of candidateIps) {
      try {
        const response = await this.requestRawViaCandidate(
          method,
          baseUrl,
          requestPath,
          body,
          candidateIp
        );
        const parsed = tryParseJsonResponse(response.bodyText, response.contentType);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            extractJiraErrorMessage(
              parsed,
              response.status,
              response.statusText,
              response.bodyText,
              response.contentType
            )
          );
        }
        if (response.bodyText.trim().length > 0 && parsed === undefined) {
          throw new Error(
            buildNonJsonJiraResponseMessage(
              response.status,
              response.statusText,
              response.contentType,
              response.bodyText
            )
          );
        }

        return parsed;
      } catch (error) {
        if (!isConnectionError(error)) {
          throw error;
        }

        failures.push(error);
      }
    }

    throw new AggregateError(failures, 'Failed to connect to Jira via all resolved internal IPs.');
  }

  private async requestMultipartViaInternalRouting(
    method: string,
    baseUrl: URL,
    requestPath: string,
    body: Buffer,
    contentType: string
  ): Promise<unknown> {
    const candidateIps = await resolveInternalCandidateIps(
      this.configStore.getJiraCloudInternalDns(),
      this.configStore.getJiraCloudPreferredResolveIp()
    );
    const failures: ConnectionError[] = [];

    for (const candidateIp of candidateIps) {
      try {
        const response = await this.requestMultipartViaCandidate(
          method,
          baseUrl,
          requestPath,
          body,
          contentType,
          candidateIp
        );
        const parsed = tryParseJsonResponse(response.bodyText, response.contentType);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            extractJiraErrorMessage(
              parsed,
              response.status,
              response.statusText,
              response.bodyText,
              response.contentType
            )
          );
        }
        return parsed;
      } catch (error) {
        if (!isConnectionError(error)) {
          throw error;
        }
        failures.push(error);
      }
    }

    throw new AggregateError(failures, 'Failed to connect to Jira via all resolved internal IPs.');
  }

  private async requestBinaryViaInternalRouting(
    method: string,
    baseUrl: URL,
    requestPath: string
  ): Promise<Buffer> {
    const candidateIps = await resolveInternalCandidateIps(
      this.configStore.getJiraCloudInternalDns(),
      this.configStore.getJiraCloudPreferredResolveIp()
    );
    const failures: ConnectionError[] = [];

    for (const candidateIp of candidateIps) {
      try {
        const response = await this.requestBinaryViaCandidate(
          method,
          baseUrl,
          requestPath,
          candidateIp
        );
        if (response.status < 200 || response.status >= 300) {
          const bodyText = response.body.toString('utf8');
          const parsed = tryParseJsonResponse(bodyText, response.contentType);
          throw new Error(
            extractJiraErrorMessage(
              parsed,
              response.status,
              response.statusText,
              bodyText,
              response.contentType
            )
          );
        }
        return response.body;
      } catch (error) {
        if (!isConnectionError(error)) {
          throw error;
        }
        failures.push(error);
      }
    }

    throw new AggregateError(failures, 'Failed to connect to Jira via all resolved internal IPs.');
  }

  private async requestJson(method: string, requestPath: string, body?: unknown): Promise<unknown> {
    return this.requestJsonDirect(method, `${this.getCloudApiBaseUrl()}${requestPath}`, body);
  }

  private async requestMultipart(method: string, requestPath: string, formData: FormData): Promise<unknown> {
    const request = new Request('https://ticket-manager.invalid/upload', {
      method,
      body: formData
    });
    const body = Buffer.from(await request.arrayBuffer());
    const contentType = request.headers.get('content-type');
    if (!contentType) {
      throw new Error('Could not build Jira attachment request body.');
    }

    return this.requestMultipartDirect(
      method,
      `${this.getCloudApiBaseUrl()}${requestPath}`,
      body,
      contentType
    );
  }

  private async requestBinary(urlValue: string): Promise<Buffer> {
    const downloadUrl = new URL(urlValue);
    const siteUrl = new URL(this.getBrowseBaseUrl());
    if (downloadUrl.hostname.toLowerCase() === siteUrl.hostname.toLowerCase()) {
      return this.requestBinaryDirect(
        'GET',
        `${this.getCloudApiBaseUrl()}${downloadUrl.pathname}${downloadUrl.search}`
      );
    }

    return this.requestBinaryDirect('GET', downloadUrl.toString());
  }

  private async getCurrentUser(): Promise<JiraCloudUser> {
    if (this.currentUser) {
      return this.currentUser;
    }
    const response = await this.requestJson('GET', '/rest/api/2/myself');
    this.currentUser = isRecord(response) ? response : {};
    return this.currentUser;
  }

  private async getFieldIds(): Promise<JiraCloudFieldIds> {
    if (this.fieldIds) {
      return this.fieldIds;
    }
    const response = await this.requestJson('GET', '/rest/api/2/field');
    const fields = toArray(response);
    const result: JiraCloudFieldIds = {};
    for (const rawField of fields) {
      if (!isRecord(rawField)) {
        continue;
      }
      const id = asString(rawField.id);
      const name = asString(rawField.name);
      const normalizedName = normalizeFieldName(name);
      if (!id || !name) {
        continue;
      }
      if (!result.epicLinkFieldId && normalizedName === 'epic link') {
        result.epicLinkFieldId = id;
        result.epicLinkFieldName = name;
      }
      if (!result.epicNameFieldId && normalizedName === 'epic name') {
        result.epicNameFieldId = id;
      }
    }
    this.fieldIds = result;
    return result;
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
      clauses.push(this.buildParentScopeClause(filters.parentKey.trim()));
    } else {
      const linkedEpicKey = this.getLinkedEpicKey();
      if (linkedEpicKey) {
        clauses.push(this.buildLinkedEpicDescendantClause(linkedEpicKey));
      }
    }
    return `${clauses.join(' AND ')} ORDER BY updated DESC`;
  }

  private buildParentScopeClause(parentKey: string): string {
    return `(parent = ${escapeJqlValue(parentKey)} OR "Epic Link" = ${escapeJqlValue(parentKey)} OR key = ${escapeJqlValue(parentKey)})`;
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

  private buildBoardJql(epicKey: string): string {
    return this.buildBoardJqlFromQuery(this.buildLinkedEpicDescendantClause(epicKey));
  }

  // Cache of nextPageToken values keyed by `${jql}|${maxResults}|${startAt}` to support
  // offset-based callers while the Jira Cloud API uses cursor-based pagination.
  private readonly searchCursorCache = new Map<string, string>();

  private async searchIssues(
    jql: string,
    fields: string[],
    startAt: number,
    maxResults: number
  ): Promise<JiraCloudSearchResult> {
    const cacheKey = `${jql}|${maxResults}|${startAt}`;
    const cursorToken = startAt === 0 ? undefined : this.searchCursorCache.get(cacheKey);

    const body: Record<string, unknown> = { jql, maxResults, fields };
    if (cursorToken) {
      body.nextPageToken = cursorToken;
    }

    const response = await this.requestJson('POST', '/rest/api/3/search/jql', body);
    const payload = isRecord(response) ? response : {};
    const rawIssues = toArray(payload.issues).filter(isRecord);
    const issues = rawIssues
      .map(issue => normalizeIssue(issue, this.getBrowseBaseUrl()))
      .filter((item): item is IssueSummary => Boolean(item));

    // Cache the next page token for sequential offset-based callers.
    const responseNextToken = asString(payload.nextPageToken ?? '') || undefined;
    if (responseNextToken) {
      const nextStartAt = startAt + issues.length;
      this.searchCursorCache.set(`${jql}|${maxResults}|${nextStartAt}`, responseNextToken);
    }

    // total is not returned by /rest/api/3/search/jql; synthesise a value that
    // lets callers derive hasMore = (startAt + issues.length < total) correctly.
    const total = startAt + issues.length + (responseNextToken ? 1 : 0);
    return { issues, total, rawIssues, nextPageToken: responseNextToken };
  }

  private async searchAllIssues(jql: string, fields: string[]): Promise<JiraCloudSearchResult> {
    const pageSize = 100;
    const allIssues: IssueSummary[] = [];
    const allRawIssues: Array<Record<string, unknown>> = [];
    let nextPageToken: string | undefined;
    while (true) {
      const body: Record<string, unknown> = { jql, maxResults: pageSize, fields };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }
      const response = await this.requestJson('POST', '/rest/api/3/search/jql', body);
      const payload = isRecord(response) ? response : {};
      const rawIssues = toArray(payload.issues).filter(isRecord);
      const issues = rawIssues
        .map(issue => normalizeIssue(issue, this.getBrowseBaseUrl()))
        .filter((item): item is IssueSummary => Boolean(item));
      allIssues.push(...issues);
      allRawIssues.push(...rawIssues);
      nextPageToken = asString(payload.nextPageToken ?? '') || undefined;
      if (!nextPageToken || issues.length === 0) {
        break;
      }
    }
    return { issues: allIssues, total: allIssues.length, rawIssues: allRawIssues };
  }

  private async fetchBoardWorkflowStatuses(
    board: Board,
    issues: IssueSummary[]
  ): Promise<string[] | undefined> {
    const projectKey = this.resolveBoardProjectKey(board, issues);
    if (!projectKey) {
      return undefined;
    }

    const issueTypeNames = this.collectBoardIssueTypeNames(issues);

    if (issueTypeNames.length === 0) {
      return undefined;
    }

    try {
      const response = await this.requestJson(
        'GET',
        `/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`
      );
      const orderedStatuses = await this.extractWorkflowStatuses(
        response,
        issueTypeNames,
        issues
      );

      return orderedStatuses.length > 0 ? orderedStatuses : undefined;
    } catch (error) {
      this.output.appendLine(
        `[jiracloud] Failed to load workflow statuses for ${projectKey}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private resolveBoardProjectKey(board: Board, issues: IssueSummary[]): string | undefined {
    const boardProjectKey = board.projectKey?.trim();
    if (boardProjectKey) {
      return boardProjectKey;
    }

    return issues.find(issue => issue.projectKey.trim())?.projectKey;
  }

  private collectBoardIssueTypeNames(issues: IssueSummary[]): string[] {
    return [
      ...new Set(
        issues
          .map(issue => issue.issueType.trim())
          .filter(issueType => issueType.length > 0)
      )
    ];
  }

  private async extractWorkflowStatuses(
    response: unknown,
    issueTypeNames: string[],
    issues: IssueSummary[]
  ): Promise<string[]> {
    const allowedIssueTypes = new Set(issueTypeNames.map(normalizeWorkflowIssueTypeName));
    const statusNameById = this.collectStatusNamesById(response, allowedIssueTypes);
    const boardConfiguredStatuses = await this.fetchBoardConfiguredStatuses(statusNameById);
    const workflowStatuses: string[] = [];
    const seenWorkflowStatuses = new Set<string>();

    for (const workflowIssueType of toArray(response).filter(isRecord)) {
      const workflowIssueTypeName = normalizeWorkflowIssueTypeName(asString(workflowIssueType.name));
      if (!allowedIssueTypes.has(workflowIssueTypeName)) {
        continue;
      }

      this.appendUniqueWorkflowStatuses(
        workflowStatuses,
        seenWorkflowStatuses,
        toArray(workflowIssueType.statuses)
      );
    }

    const issueStatuses = issues
      .map(issue => issue.status?.trim())
      .filter((statusName): statusName is string => Boolean(statusName));

    return resolveBoardWorkflowStatusOrder(boardConfiguredStatuses, workflowStatuses, issueStatuses);
  }

  private collectStatusNamesById(
    response: unknown,
    allowedIssueTypes: Set<string>
  ): Map<string, string> {
    const statusNameById = new Map<string, string>();

    for (const workflowIssueType of toArray(response).filter(isRecord)) {
      const workflowIssueTypeName = normalizeWorkflowIssueTypeName(asString(workflowIssueType.name));
      if (!allowedIssueTypes.has(workflowIssueTypeName)) {
        continue;
      }

      for (const rawStatus of toArray(workflowIssueType.statuses).filter(isRecord)) {
        const statusId = asString(rawStatus.id)?.trim();
        const statusName = asString(rawStatus.name)?.trim();
        if (!statusId || !statusName || statusNameById.has(statusId)) {
          continue;
        }

        statusNameById.set(statusId, statusName);
      }
    }

    return statusNameById;
  }

  private async fetchBoardConfiguredStatuses(
    statusNameById: Map<string, string>
  ): Promise<string[]> {
    const rapidViewId = this.configStore.getJiraPollingRapidViewId();
    if (!rapidViewId) {
      return [];
    }

    const orderedStatuses: string[] = [];
    const seen = new Set<string>();

    try {
      const response = await this.requestJson(
        'GET',
        `/rest/agile/1.0/board/${encodeURIComponent(String(rapidViewId))}/configuration`
      );
      const columnConfig = isRecord(response) && isRecord(response.columnConfig)
        ? response.columnConfig
        : undefined;
      const columns = columnConfig ? toArray(columnConfig.columns).filter(isRecord) : [];

      for (const column of columns) {
        let appendedFromStatuses = false;
        for (const rawStatus of toArray(column.statuses).filter(isRecord)) {
          const agileStatus = rawStatus as JiraAgileBoardColumnStatus;
          const statusId = asString(agileStatus.id)?.trim();
          const configuredName = asString(agileStatus.name)?.trim();
          const statusName = configuredName || (statusId ? statusNameById.get(statusId) : undefined);
          if (!statusName) {
            continue;
          }

          appendUniqueStatusName(orderedStatuses, seen, statusName);
          appendedFromStatuses = true;
        }

        if (!appendedFromStatuses) {
          appendUniqueStatusName(orderedStatuses, seen, asString(column.name));
        }
      }

      if (orderedStatuses.length > 0) {
        this.output.appendLine(
          `[jiracloud] Using agile board ${rapidViewId} status order: ${orderedStatuses.join(' | ')}`
        );
      }

      return orderedStatuses;
    } catch (error) {
      this.output.appendLine(
        `[jiracloud] Failed to load agile board configuration for ${rapidViewId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  private appendUniqueWorkflowStatuses(
    orderedStatuses: string[],
    seen: Set<string>,
    rawStatuses: unknown[]
  ): void {
    for (const rawStatus of rawStatuses) {
      if (!isRecord(rawStatus)) {
        continue;
      }

      const statusName = asString(rawStatus.name)?.trim();
      appendUniqueStatusName(orderedStatuses, seen, statusName);
    }
  }

  private appendIssueStatuses(
    orderedStatuses: string[],
    seen: Set<string>,
    issues: IssueSummary[]
  ): void {
    for (const issue of issues) {
      appendUniqueStatusName(orderedStatuses, seen, issue.status);
    }
  }

  private parseEpicKey(boardId: string): string | undefined {
    return boardId.startsWith('epic:') ? boardId.slice('epic:'.length) : undefined;
  }

  private getLinkedEpicBoardName(): string | undefined {
    return this.configStore.getJiraCloudEpicBoardName().trim() || undefined;
  }

  private parseJqlBoardQuery(board: Board): string | undefined {
    if (board.id === 'jql:workspace') {
      if (!isRecord(board.raw)) {
        return this.getLinkedBoardJql();
      }
      const jql = asString(board.raw.jql)?.trim();
      return jql || this.getLinkedBoardJql();
    }

    if (board.id.startsWith(CUSTOM_JQL_BOARD_PREFIX)) {
      const encoded = board.id.slice(CUSTOM_JQL_BOARD_PREFIX.length);
      if (!encoded) {
        return undefined;
      }
      try {
        const decoded = decodeURIComponent(encoded).trim();
        return decoded || undefined;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private getLinkedEpicKey(): string | undefined {
    return this.configStore.getJiraCloudEpicKey().trim() || undefined;
  }

  private getLinkedBoardJql(): string | undefined {
    return this.configStore.getJiraCloudBoardJql().trim() || undefined;
  }

  private getLinkedBoardName(): string | undefined {
    return this.configStore.getJiraCloudBoardName().trim() || undefined;
  }

  private buildJqlBoardName(jql: string): string {
    const compact = jql.replace(/\s+/g, ' ').trim();
    if (compact.length <= 56) {
      return `JQL ${compact}`;
    }
    return `JQL ${compact.slice(0, 53)}...`;
  }

  private parseAgileBoardId(board: Board): string | undefined {
    if (isRecord(board.raw)) {
      const rawId = asString(board.raw.agileBoardId)?.trim();
      if (rawId) {
        return rawId;
      }
    }

    if (board.id.startsWith('agile:')) {
      const id = board.id.slice('agile:'.length).trim();
      return id || undefined;
    }

    return undefined;
  }

  private async fetchAgileBoards(): Promise<Board[]> {
    const boards: Board[] = [];
    const seen = new Set<string>();
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const response = await this.requestJson(
        'GET',
        `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${maxResults}`
      );
      const payload = isRecord(response) ? response : {};
      const values = toArray(payload.values).filter(isRecord);

      for (const rawBoard of values) {
        const rawId = asString(rawBoard.id)?.trim();
        if (!rawId || seen.has(rawId)) {
          continue;
        }
        seen.add(rawId);

        const location = isRecord(rawBoard.location) ? rawBoard.location : undefined;
        const locationProject = location && isRecord(location.project) ? location.project : undefined;

        const projectKey =
          asString(locationProject?.key)?.trim() ?? asString(location?.projectKey)?.trim();
        const projectName =
          asString(locationProject?.name)?.trim() ?? asString(location?.name)?.trim();
        const locationName =
          asString(location?.displayName)?.trim() ?? projectName;

        boards.push({
          id: `agile:${rawId}`,
          name: asString(rawBoard.name)?.trim() || `Board ${rawId}`,
          type: asString(rawBoard.type)?.trim().toLowerCase() || 'board',
          projectKey,
          projectName,
          locationName,
          raw: { agileBoardId: rawId }
        });
      }

      const isLast = payload.isLast === true;
      const total =
        typeof payload.total === 'number' && Number.isFinite(payload.total) ? payload.total : undefined;
      if (isLast || values.length === 0) {
        break;
      }

      startAt += values.length;
      if (typeof total === 'number' && startAt >= total) {
        break;
      }
    }

    return boards;
  }

  private async fetchAgileBoardIssues(boardId: string): Promise<IssueSummary[]> {
    const issues: IssueSummary[] = [];
    let startAt = 0;
    const maxResults = 100;
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

    while (true) {
      const response = await this.requestJson(
        'GET',
        `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?startAt=${startAt}&maxResults=${maxResults}&fields=${encodeURIComponent(fields.join(','))}`
      );
      const payload = isRecord(response) ? response : {};
      const rawIssues = toArray(payload.issues).filter(isRecord);
      const normalized = rawIssues
        .map(issue => normalizeIssue(issue, this.getBrowseBaseUrl()))
        .filter((item): item is IssueSummary => Boolean(item));
      issues.push(...normalized);

      const isLast = payload.isLast === true;
      const total =
        typeof payload.total === 'number' && Number.isFinite(payload.total) ? payload.total : undefined;
      if (isLast || rawIssues.length === 0) {
        break;
      }

      startAt += rawIssues.length;
      if (typeof total === 'number' && startAt >= total) {
        break;
      }
    }

    return issues;
  }

  private async getBoardScopedIssues(filters: IssueFilters): Promise<IssueSummary[] | undefined> {
    const boardId = filters.boardId?.trim();
    if (!boardId) {
      return undefined;
    }

    const board = await this.resolveBoardById(boardId);
    if (!board) {
      return [];
    }

    const details = await this.getBoardDetails(board);
    return details.issues;
  }

  private async resolveBoardById(boardId: string): Promise<Board | undefined> {
    const boards = await this.getBoards({ projectKeys: [], types: [], searchText: '' });
    return boards.find(board => board.id === boardId);
  }

  private async filterIssuesForSidebar(issues: IssueSummary[], filters: IssueFilters): Promise<IssueSummary[]> {
    const normalizedSearchText = filters.searchText.trim().toLowerCase();
    const normalizedStatuses = new Set(filters.statuses.map(status => status.trim().toLowerCase()));
    const normalizedIssueTypes = new Set(filters.issueTypes.map(type => type.trim().toLowerCase()));
    const normalizedProjectKeys = new Set(filters.projectKeys.map(projectKey => projectKey.trim().toLowerCase()));
    const normalizedParentKey = filters.parentKey?.trim().toLowerCase();
    const currentUserTokens =
      filters.assigneeMode === 'me' ? await this.getCurrentUserMatchTokens() : undefined;

    return issues.filter(issue => {
      if (normalizedProjectKeys.size > 0 && !normalizedProjectKeys.has(issue.projectKey.trim().toLowerCase())) {
        return false;
      }
      if (normalizedStatuses.size > 0 && !normalizedStatuses.has(issue.status.trim().toLowerCase())) {
        return false;
      }
      if (normalizedIssueTypes.size > 0 && !normalizedIssueTypes.has(issue.issueType.trim().toLowerCase())) {
        return false;
      }
      if (filters.assigneeMode === 'me') {
        const assignee = issue.assignee?.trim().toLowerCase();
        if (!assignee || !currentUserTokens?.has(assignee)) {
          return false;
        }
      }
      if (normalizedParentKey) {
        const issueKey = issue.key.trim().toLowerCase();
        const parentKey = issue.parentKey?.trim().toLowerCase();
        if (issueKey !== normalizedParentKey && parentKey !== normalizedParentKey) {
          return false;
        }
      }
      if (normalizedSearchText.length > 0) {
        const target = `${issue.key} ${issue.summary} ${issue.description ?? ''}`.toLowerCase();
        if (!target.includes(normalizedSearchText)) {
          return false;
        }
      }
      return true;
    });
  }

  private async getCurrentUserMatchTokens(): Promise<Set<string>> {
    const currentUser = await this.getCurrentUser();
    const tokens = [currentUser.displayName, currentUser.name, currentUser.key, currentUser.accountId]
      .map(value => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    return new Set(tokens);
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

    if (filters.searchText.trim().length === 0) {
      return true;
    }

    const boardQuery = this.parseJqlBoardQuery(board) ?? '';
    const searchTarget = `${board.name} ${board.projectName ?? ''} ${boardQuery}`.toLowerCase();
    return searchTarget.includes(filters.searchText.trim().toLowerCase());
  }

  private resolveProjectScope(projectKeys: string[]): string[] {
    if (projectKeys.length > 0) {
      return projectKeys;
    }

    const defaultProjectKey = this.configStore.getJiraPollingProjectKey().trim();
    return defaultProjectKey ? [defaultProjectKey] : [];
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



