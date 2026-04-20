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

export class GitLabApiService {
  public constructor(
    private readonly config: GitLabApiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  public async listMergeRequestsForIssue(issueKey: string): Promise<GitLabMergeRequest[]> {
    const mergeRequests = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests`,
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

  public async listMergeRequestsForSourceBranch(sourceBranch: string): Promise<GitLabMergeRequest[]> {
    const mergeRequests = await this.requestJson<Record<string, unknown>[]>(
      'GET',
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests`,
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
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests/${iid}`
    );
    return normalizeMergeRequest(mergeRequest);
  }

  public async createMergeRequest(input: GitLabCreateMergeRequestInput): Promise<GitLabMergeRequest> {
    const mergeRequest = await this.requestJson<Record<string, unknown>>(
      'POST',
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests`,
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
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests/${iid}/discussions`,
      { per_page: '100' }
    );

    return flattenGitLabDiscussionNotes(discussions);
  }

  public async addMergeRequestNote(iid: number, body: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/api/v4/projects/${encodeURIComponent(this.config.projectPath)}/merge_requests/${iid}/notes`,
      undefined,
      { body: body.trim() }
    );
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    pathname: string,
    query?: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<T> {
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
      throw new Error(`GitLab request failed with HTTP ${response.status} (${response.statusText}). Response: ${responseText}`);
    }

    if (!responseText.trim()) {
      return [] as T;
    }

    return JSON.parse(responseText) as T;
  }
}