import { execFile as execFileCallback } from 'node:child_process';
import * as util from 'node:util';

const execFile = util.promisify(execFileCallback);

export const TICKET_MANAGER_MR_REPLY_MARKER = '<!-- ticket-manager-mr-reply -->';

export interface GitLabProjectRemote {
  baseUrl: string;
  projectPath: string;
}

export interface GitLabApiConfig {
  baseUrl: string;
  projectPath: string;
  token: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  pathWithNamespace: string;
  webUrl?: string;
}

export interface GitLabUser {
  id: number;
  username?: string;
  name?: string;
  state?: string;
}

export interface GitLabBoardList {
  id: number;
  title: string;
  position: number;
  kind?: 'label' | 'assignee' | 'milestone' | 'iteration';
  labelName?: string;
  assigneeId?: number;
  assigneeUsername?: string;
  milestoneId?: number;
  milestoneTitle?: string;
  iterationId?: number;
  iterationTitle?: string;
  raw: unknown;
}

export interface GitLabBoard {
  id: number;
  name: string;
  project: GitLabProject;
  webUrl?: string;
  hideBacklogList: boolean;
  hideClosedList: boolean;
  assigneeUsername?: string;
  milestoneTitle?: string;
  labels: string[];
  weight?: number;
  lists: GitLabBoardList[];
  raw: unknown;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  state: string;
  webUrl?: string;
  authorName?: string;
  assignees: Array<{ username?: string; name?: string }>;
  labels: string[];
  milestoneTitle?: string;
  iterationTitle?: string;
  createdAt?: string;
  updatedAt?: string;
  description?: string;
  references?: {
    full?: string;
    relative?: string;
    short?: string;
  };
  raw: unknown;
}

export interface GitLabIssueComment {
  id: string;
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  raw: unknown;
}

export interface GitLabMergeRequest {
  projectId: number;
  iid: number;
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  webUrl: string;
  createdAt?: string;
  updatedAt?: string;
  mergeCommitSha?: string;
  headSha?: string;
}

export interface GitLabDiscussionNote {
  id: string;
  discussionId: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  system: boolean;
}

export interface GitLabCreateMergeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  removeSourceBranch?: boolean;
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

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Build a concise, user-facing error message for a failed GitLab request.
 * GitLab returns error details in the response body, often as JSON like
 * `{"message":"401 Unauthorized"}` or `{"error":"..."}`. Surfacing the raw body
 * floods the UI with JSON, so extract a short message and fall back to the HTTP
 * status when no readable detail is available.
 */
function formatGitLabError(status: number, statusText: string, responseText: string): string {
  const statusSuffix = statusText ? ` ${statusText}` : '';
  const base = `GitLab request failed (HTTP ${status}${statusSuffix})`;
  const detail = extractGitLabErrorDetail(responseText);
  return detail ? `${base}: ${detail}` : `${base}.`;
}

function extractGitLabErrorDetail(responseText: string): string | undefined {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return undefined;
  }

  // Try to parse a structured GitLab error body.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') {
      return truncateErrorDetail(parsed);
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      // GitLab uses `message` or `error`; `message` can be a string, an array,
      // or a nested object of field -> messages.
      const message = record.message ?? record.error ?? record.error_description;
      const flattened = flattenGitLabMessage(message);
      if (flattened) {
        return truncateErrorDetail(flattened);
      }
    }
  } catch {
    // Not JSON; fall through to returning the raw (truncated) text.
  }

  return truncateErrorDetail(trimmed);
}

function flattenGitLabMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(flattenGitLabMessage).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  if (value && typeof value === 'object') {
    const parts: string[] = [];
    for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      const flattened = flattenGitLabMessage(fieldValue);
      if (flattened) {
        parts.push(`${field}: ${flattened}`);
      }
    }
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return undefined;
}

function truncateErrorDetail(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  const MAX = 200;
  return normalized.length > MAX ? `${normalized.slice(0, MAX - 1)}…` : normalized;
}

export function parseGitLabRemoteUrl(remoteUrl: string): GitLabProjectRemote {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    throw new Error('The git remote URL is empty.');
  }

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch) {
    return {
      baseUrl: `https://${sshMatch[1]}`,
      projectPath: sshMatch[2]
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported git remote URL format: ${trimmed}`);
  }

  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    projectPath: parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '')
  };
}

export async function inferGitLabProjectFromRepo(repoPath: string): Promise<GitLabProjectRemote> {
  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
    cwd: repoPath,
    windowsHide: true
  });

  return parseGitLabRemoteUrl(stdout.trim());
}

export function createIssueKeyMatcher(issueKey: string): RegExp {
  const escapedKey = escapeForRegExp(issueKey.trim().toUpperCase());
  return new RegExp(`(^|[^A-Z0-9])${escapedKey}([^A-Z0-9]|$)`, 'i');
}

export function mergeRequestMatchesIssueKey(
  mergeRequest: Pick<GitLabMergeRequest, 'title' | 'description' | 'sourceBranch'>,
  issueKey: string
): boolean {
  const matcher = createIssueKeyMatcher(issueKey);
  return [mergeRequest.title, mergeRequest.description, mergeRequest.sourceBranch]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .some(value => matcher.test(value.toUpperCase()));
}

export function flattenGitLabDiscussionNotes(discussions: unknown[]): GitLabDiscussionNote[] {
  return discussions
    .flatMap(discussion => {
      const discussionId = String((discussion as { id?: string })?.id ?? '');
      const noteEntries = Array.isArray((discussion as { notes?: unknown[] })?.notes)
        ? (discussion as { notes: unknown[] }).notes
        : [];
      return noteEntries.map(note => {
        const entry = note as {
          id?: number | string;
          body?: string;
          created_at?: string;
          updated_at?: string;
          system?: boolean;
          author?: { username?: string; name?: string };
        };
        return {
          id: String(entry.id ?? ''),
          discussionId,
          author: entry.author?.username ?? entry.author?.name ?? 'unknown',
          body: entry.body ?? '',
          createdAt: entry.created_at ?? '',
          updatedAt: entry.updated_at ?? entry.created_at ?? '',
          system: entry.system === true
        };
      });
    })
    .filter(note => note.id.length > 0)
    .sort((left, right) => {
      const timestampComparison = left.createdAt.localeCompare(right.createdAt);
      if (timestampComparison !== 0) {
        return timestampComparison;
      }

      return left.id.localeCompare(right.id, 'en', { sensitivity: 'base' });
    });
}

export function createGitLabHandledNoteState(notes: GitLabDiscussionNote[]): Record<string, string> {
  const state: Record<string, string> = {};
  for (const note of notes) {
    state[note.id] = note.updatedAt;
  }
  return state;
}

export function diffGitLabDiscussionNotes(
  previousNotes: Record<string, string> | undefined,
  currentNotes: GitLabDiscussionNote[],
  isBaseline: boolean
): {
  newNotes: GitLabDiscussionNote[];
  updatedNotes: GitLabDiscussionNote[];
} {
  if (isBaseline) {
    return {
      newNotes: [],
      updatedNotes: []
    };
  }

  const priorState = previousNotes ?? {};
  const newNotes: GitLabDiscussionNote[] = [];
  const updatedNotes: GitLabDiscussionNote[] = [];

  for (const note of currentNotes) {
    const previousUpdatedAt = priorState[note.id];
    if (!previousUpdatedAt) {
      newNotes.push(note);
      continue;
    }

    if (previousUpdatedAt !== note.updatedAt) {
      updatedNotes.push(note);
    }
  }

  return {
    newNotes,
    updatedNotes
  };
}

export function isTicketManagerManagedMergeRequestNote(body: string): boolean {
  return body.trimStart().startsWith(TICKET_MANAGER_MR_REPLY_MARKER);
}

export function wrapTicketManagerManagedMergeRequestNote(body: string): string {
  return `${TICKET_MANAGER_MR_REPLY_MARKER}\n${body.trim()}`;
}

export function isDoneLikeStatus(status: string | undefined, statusCategory?: string): boolean {
  const normalizedStatus = status?.trim().toLowerCase() ?? '';
  const normalizedCategory = statusCategory?.trim().toLowerCase() ?? '';
  return normalizedCategory === 'done' || /^(done|closed|resolved)$/.test(normalizedStatus);
}

export function isInReviewLikeStatus(status: string | undefined): boolean {
  const normalizedStatus = status?.trim().toLowerCase() ?? '';
  return normalizedStatus === 'in review' || normalizedStatus === 'review';
}

export function shouldCreateMergeRequestForStatusChange(options: {
  previousStatus?: string;
  currentStatus?: string;
  currentStatusCategory?: string;
}): boolean {
  return isInReviewLikeStatus(options.previousStatus) && isDoneLikeStatus(options.currentStatus, options.currentStatusCategory);
}

function normalizeMergeRequest(raw: Record<string, unknown>): GitLabMergeRequest {
  const diffRefs = typeof raw.diff_refs === 'object' && raw.diff_refs !== null
    ? raw.diff_refs as { head_sha?: string }
    : undefined;
  return {
    projectId: Number(raw.project_id ?? 0),
    iid: Number(raw.iid ?? 0),
    title: asString(raw.title) ?? '',
    description: asString(raw.description),
    sourceBranch: asString(raw.source_branch) ?? '',
    targetBranch: asString(raw.target_branch) ?? '',
    state: asString(raw.state) ?? '',
    webUrl: asString(raw.web_url) ?? '',
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
    mergeCommitSha: typeof raw.merge_commit_sha === 'string' ? raw.merge_commit_sha : undefined,
    headSha: asString(raw.sha) ?? diffRefs?.head_sha
  };
}

function normalizeProject(raw: Record<string, unknown>): GitLabProject {
  return {
    id: Number(raw.id ?? 0),
    name: asString(raw.name) ?? '',
    path: asString(raw.path) ?? '',
    pathWithNamespace: asString(raw.path_with_namespace) ?? asString(raw.path) ?? '',
    webUrl: asString(raw.web_url)
  };
}

function normalizeGitLabUser(raw: Record<string, unknown>): GitLabUser {
  return {
    id: Number(raw.id ?? 0),
    username: asString(raw.username),
    name: asString(raw.name),
    state: asString(raw.state)
  };
}

function getBoardListKind(raw: {
  label?: Record<string, unknown>;
  assignee?: Record<string, unknown>;
  milestone?: Record<string, unknown>;
  iteration?: Record<string, unknown>;
}): GitLabBoardList['kind'] {
  if (raw.label) {
    return 'label';
  }

  if (raw.assignee) {
    return 'assignee';
  }

  if (raw.milestone) {
    return 'milestone';
  }

  if (raw.iteration) {
    return 'iteration';
  }

  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeBoardList(raw: Record<string, unknown>): GitLabBoardList {
  const label = toRecord(raw.label);
  const assignee = toRecord(raw.assignee);
  const milestone = toRecord(raw.milestone);
  const iteration = toRecord(raw.iteration);

  const title = asString(label?.name)
    ?? asString(assignee?.name)
    ?? asString(milestone?.title)
    ?? asString(iteration?.title)
    ?? asString(raw.list_type)
    ?? `List ${typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : 'unknown'}`;

  return {
    id: Number(raw.id ?? 0),
    title,
    position: Number(raw.position ?? 0),
    kind: getBoardListKind({ label, assignee, milestone, iteration }),
    labelName: asString(label?.name),
    assigneeId: toOptionalNumber(assignee?.id),
    assigneeUsername: asString(assignee?.username),
    milestoneId: toOptionalNumber(milestone?.id),
    milestoneTitle: asString(milestone?.title),
    iterationId: toOptionalNumber(iteration?.id),
    iterationTitle: asString(iteration?.title),
    raw
  };
}

function normalizeBoard(raw: Record<string, unknown>): GitLabBoard {
  const rawProject = typeof raw.project === 'object' && raw.project !== null
    ? raw.project as Record<string, unknown>
    : {};
  const rawAssignee = typeof raw.assignee === 'object' && raw.assignee !== null
    ? raw.assignee as Record<string, unknown>
    : undefined;
  const rawMilestone = typeof raw.milestone === 'object' && raw.milestone !== null
    ? raw.milestone as Record<string, unknown>
    : undefined;
  const rawLabels = Array.isArray(raw.labels)
    ? raw.labels as Array<Record<string, unknown> | string>
    : [];
  const rawLists = Array.isArray(raw.lists)
    ? raw.lists as Record<string, unknown>[]
    : [];

  return {
    id: Number(raw.id ?? 0),
    name: asString(raw.name) ?? '',
    project: normalizeProject(rawProject),
    webUrl: asString(raw.web_url) ?? asString(rawProject.web_url),
    hideBacklogList: raw.hide_backlog_list === true,
    hideClosedList: raw.hide_closed_list === true,
    assigneeUsername: asString(rawAssignee?.username),
    milestoneTitle: asString(rawMilestone?.title),
    labels: rawLabels
      .map(label => typeof label === 'string' ? label : asString(label.name))
      .filter((label): label is string => Boolean(label?.trim())),
    weight: typeof raw.weight === 'number' ? raw.weight : undefined,
    lists: rawLists.map(normalizeBoardList).sort((left, right) => left.position - right.position),
    raw
  };
}

function normalizeIssue(raw: Record<string, unknown>): GitLabIssue {
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees as Array<Record<string, unknown>>
    : [];
  const milestone = typeof raw.milestone === 'object' && raw.milestone !== null
    ? raw.milestone as Record<string, unknown>
    : undefined;
  const iteration = typeof raw.iteration === 'object' && raw.iteration !== null
    ? raw.iteration as Record<string, unknown>
    : undefined;
  const references = typeof raw.references === 'object' && raw.references !== null
    ? raw.references as Record<string, unknown>
    : undefined;

  return {
    id: Number(raw.id ?? 0),
    iid: Number(raw.iid ?? 0),
    projectId: Number(raw.project_id ?? 0),
    title: asString(raw.title) ?? '',
    state: asString(raw.state) ?? '',
    webUrl: asString(raw.web_url),
    authorName:
      typeof raw.author === 'object' && raw.author !== null
        ? asString((raw.author as Record<string, unknown>).name) ?? asString((raw.author as Record<string, unknown>).username)
        : undefined,
    assignees: assignees.map(assignee => ({
      username: asString(assignee.username),
      name: asString(assignee.name)
    })),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map(label => asString(label)).filter((label): label is string => Boolean(label?.trim()))
      : [],
    milestoneTitle: asString(milestone?.title),
    iterationTitle: asString(iteration?.title),
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
    description: asString(raw.description),
    references: references
      ? {
          full: asString(references.full),
          relative: asString(references.relative),
          short: asString(references.short)
        }
      : undefined,
    raw
  };
}

function normalizeIssueComment(raw: Record<string, unknown>): GitLabIssueComment {
  const author = typeof raw.author === 'object' && raw.author !== null
    ? raw.author as Record<string, unknown>
    : undefined;

  return {
    id: asString(raw.id) ?? '',
    author: asString(author?.name) ?? asString(author?.username),
    body: asString(raw.body) ?? '',
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
    raw
  };
}

export class GitLabApiService {
  public constructor(
    private readonly config: GitLabApiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  public async listMergeRequestsForIssue(issueKey: string): Promise<GitLabMergeRequest[]> {
    const mergeRequests = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests`,
      {
        state: 'all',
        scope: 'all',
        search: issueKey,
        per_page: '100',
        order_by: 'updated_at',
        sort: 'desc'
      }
    );

    return mergeRequests
      .map(normalizeMergeRequest)
      .filter(mergeRequest => mergeRequestMatchesIssueKey(mergeRequest, issueKey));
  }

  public async getProject(projectRef?: string | number): Promise<GitLabProject> {
    const project = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}`
    );

    return normalizeProject(project);
  }

  public async getCurrentUser(): Promise<GitLabUser> {
    const user = await this.requestJson<Record<string, unknown>>('GET', '/api/v4/user');
    return normalizeGitLabUser(user);
  }

  public async findUsers(searchText: string): Promise<GitLabUser[]> {
    const trimmed = searchText.trim();
    if (!trimmed) {
      return [];
    }

    const exactUsers = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      '/api/v4/users',
      {
        username: trimmed,
        active: 'true'
      }
    );
    if (exactUsers.length > 0) {
      return exactUsers.map(normalizeGitLabUser);
    }

    const matchingUsers = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      '/api/v4/users',
      {
        search: trimmed,
        active: 'true',
        per_page: '100'
      }
    );
    return matchingUsers.map(normalizeGitLabUser);
  }

  public async listAccessibleProjects(searchText?: string): Promise<GitLabProject[]> {
    const projects = await this.requestJsonPaginated<Record<string, unknown>>(
      '/api/v4/projects',
      {
        membership: 'true',
        simple: 'true',
        archived: 'false',
        order_by: 'last_activity_at',
        sort: 'desc',
        search: searchText?.trim() || undefined
      }
    );

    return projects.map(normalizeProject);
  }

  public async listBoards(projectRef?: string | number): Promise<GitLabBoard[]> {
    const boards = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/boards`
    );

    return boards.map(normalizeBoard);
  }

  public async getBoard(boardId: number, projectRef?: string | number): Promise<GitLabBoard> {
    const board = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/boards/${boardId}`
    );

    return normalizeBoard(board);
  }

  public async listBoardLists(boardId: number, projectRef?: string | number): Promise<GitLabBoardList[]> {
    const lists = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/boards/${boardId}/lists`
    );

    return lists.map(normalizeBoardList).sort((left, right) => left.position - right.position);
  }

  public async listIssues(
    projectRef?: string | number,
    filters?: {
      state?: 'opened' | 'closed' | 'all';
      labels?: string[];
      assigneeUsername?: string;
      milestoneTitle?: string;
      iterationTitle?: string;
      weight?: number;
    }
  ): Promise<GitLabIssue[]> {
    const issues = await this.requestJsonPaginated<Record<string, unknown>>(
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/issues`,
      {
        scope: 'all',
        state: filters?.state ?? 'all',
        labels: filters?.labels?.length ? filters.labels.join(',') : undefined,
        assignee_username: filters?.assigneeUsername,
        milestone: filters?.milestoneTitle,
        iteration_title: filters?.iterationTitle,
        weight: typeof filters?.weight === 'number' ? String(filters.weight) : undefined,
        with_labels_details: 'false',
        order_by: 'updated_at',
        sort: 'desc'
      }
    );

    return issues.map(normalizeIssue);
  }

  public async getIssue(issueIid: number, projectRef?: string | number): Promise<GitLabIssue> {
    const issue = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/issues/${issueIid}`
    );

    return normalizeIssue(issue);
  }

  public async listIssueComments(issueIid: number, projectRef?: string | number): Promise<GitLabIssueComment[]> {
    const notes = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/issues/${issueIid}/notes`,
      {
        sort: 'asc',
        order_by: 'created_at',
        per_page: '100'
      }
    );

    return notes.map(normalizeIssueComment);
  }

  public async addIssueComment(issueIid: number, body: string, projectRef?: string | number): Promise<void> {
    await this.requestJson(
      'POST',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/issues/${issueIid}/notes`,
      undefined,
      { body: body.trim() }
    );
  }

  public async updateIssue(
    issueIid: number,
    input: {
      title?: string;
      description?: string;
      stateEvent?: 'close' | 'reopen';
      addLabels?: string[];
      removeLabels?: string[];
      assigneeIds?: number[];
      milestoneId?: number;
      iterationId?: number;
    },
    projectRef?: string | number
  ): Promise<GitLabIssue> {
    let assigneeIds: string | undefined;
    if (input.assigneeIds) {
      assigneeIds = input.assigneeIds.length > 0 ? input.assigneeIds.join(',') : '0';
    }

    const issue = await this.requestJson<Record<string, unknown>>(
      'PUT',
      `/api/v4/projects/${this.encodeProjectRef(projectRef)}/issues/${issueIid}`,
      undefined,
      {
        title: input.title,
        description: input.description,
        state_event: input.stateEvent,
        add_labels: input.addLabels?.length ? input.addLabels.join(',') : undefined,
        remove_labels: input.removeLabels?.length ? input.removeLabels.join(',') : undefined,
        assignee_ids: assigneeIds,
        milestone_id: typeof input.milestoneId === 'number' ? String(input.milestoneId) : undefined,
        iteration_id: typeof input.iterationId === 'number' ? String(input.iterationId) : undefined
      }
    );

    return normalizeIssue(issue);
  }

  public async listMergeRequestsForSourceBranch(sourceBranch: string): Promise<GitLabMergeRequest[]> {
    const mergeRequests = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests`,
      {
        state: 'all',
        scope: 'all',
        source_branch: sourceBranch,
        per_page: '100',
        order_by: 'updated_at',
        sort: 'desc'
      }
    );

    return mergeRequests.map(normalizeMergeRequest);
  }

  public async getMergeRequest(iid: number): Promise<GitLabMergeRequest> {
    const mergeRequest = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests/${iid}`
    );
    return normalizeMergeRequest(mergeRequest);
  }

  public async createMergeRequest(input: GitLabCreateMergeRequestInput): Promise<GitLabMergeRequest> {
    const mergeRequest = await this.requestJson<Record<string, unknown>>(
      'POST',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests`,
      undefined,
      {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description ?? '',
        remove_source_branch: input.removeSourceBranch === true
      }
    );
    return normalizeMergeRequest(mergeRequest);
  }

  public async listMergeRequestDiscussions(iid: number): Promise<GitLabDiscussionNote[]> {
    const discussions = await this.requestJson<unknown[]>(
      'GET',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests/${iid}/discussions`,
      { per_page: '100' }
    );

    return flattenGitLabDiscussionNotes(discussions);
  }

  public async addMergeRequestNote(iid: number, body: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests/${iid}/notes`,
      undefined,
      { body: body.trim() }
    );
  }

  public async replyToMergeRequestDiscussion(iid: number, discussionId: string, body: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/api/v4/projects/${this.encodeProjectRef()}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      undefined,
      { body: body.trim() }
    );
  }

  private encodeProjectRef(projectRef?: string | number): string {
    const value = projectRef ?? this.config.projectPath;
    if (typeof value === 'number') {
      return String(value);
    }

    const trimmed = value?.trim();
    if (!trimmed) {
      throw new Error('No GitLab project path is configured.');
    }

    return encodeURIComponent(trimmed);
  }

  private async requestJsonPaginated<T>(
    pathname: string,
    query?: Record<string, string | undefined>
  ): Promise<T[]> {
    const results: T[] = [];
    let nextPage = '1';

    while (nextPage) {
      const { data, headers } = await this.requestJsonWithHeaders<T[]>(
        'GET',
        pathname,
        query
          ? { ...query, per_page: '100', page: nextPage }
          : { per_page: '100', page: nextPage }
      );
      results.push(...data);
      nextPage = headers.get('x-next-page')?.trim() ?? '';
    }

    return results;
  }

  private async requestJsonWithHeaders<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pathname: string,
    query?: Record<string, string | undefined>,
    body?: Record<string, unknown>
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!value) {
        continue;
      }
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': body ? 'application/x-www-form-urlencoded' : 'application/json',
        'PRIVATE-TOKEN': this.config.token
      },
      body: body ? new URLSearchParams(Object.entries(body).reduce<Record<string, string>>((result, [key, value]) => {
        if (value === undefined || value === null) {
          return result;
        }
        const text = asString(value);
        if (text !== undefined) {
          result[key] = text;
        }
        return result;
      }, {})).toString() : undefined
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(formatGitLabError(response.status, response.statusText, responseText));
    }

    if (!responseText.trim()) {
      return { data: [] as T, headers: response.headers };
    }

    return {
      data: JSON.parse(responseText) as T,
      headers: response.headers
    };
  }

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pathname: string,
    query?: Record<string, string | undefined>,
    body?: Record<string, unknown>
  ): Promise<T> {
    const { data } = await this.requestJsonWithHeaders<T>(method, pathname, query, body);
    return data;
  }
}