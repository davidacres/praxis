const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubApiConfig {
  /** API base URL — `https://api.github.com` for github.com, or a GitHub Enterprise Server host. */
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
}

export interface GitHubUser {
  login: string;
  name?: string;
}

export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  /** `open` or `closed` — GitHub's only native state. */
  state: string;
  htmlUrl?: string;
  authorLogin?: string;
  assignees: Array<{ login: string; name?: string }>;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  body?: string;
  /** True for a pull request returned by the issues endpoint — filtered out by callers. */
  isPullRequest: boolean;
  raw: unknown;
}

export interface GitHubIssueComment {
  id: string;
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  raw: unknown;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  htmlUrl?: string;
  private: boolean;
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

/**
 * GitHub returns `{"message": "...", "errors": [{resource, field, code, message}]}`
 * for validation failures and a plain `{"message": "..."}` for everything else.
 * Surfacing the raw body floods the UI with JSON, so extract a short message.
 */
function formatGitHubError(status: number, statusText: string, responseText: string): string {
  const statusSuffix = statusText ? ` ${statusText}` : '';
  const base = `GitHub request failed (HTTP ${status}${statusSuffix})`;
  const detail = extractGitHubErrorDetail(responseText);
  return detail ? `${base}: ${detail}` : `${base}.`;
}

function extractGitHubErrorDetail(responseText: string): string | undefined {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const parts: string[] = [];
      const message = asString(record.message);
      if (message) {
        parts.push(message);
      }
      if (Array.isArray(record.errors)) {
        for (const entry of record.errors) {
          if (entry && typeof entry === 'object') {
            const errorRecord = entry as Record<string, unknown>;
            const field = asString(errorRecord.field);
            const code = asString(errorRecord.code);
            const errorMessage = asString(errorRecord.message);
            const detail = errorMessage ?? code;
            if (field && detail) {
              parts.push(`${field}: ${detail}`);
            } else if (detail) {
              parts.push(detail);
            }
          }
        }
      }
      if (parts.length > 0) {
        return truncateErrorDetail(parts.join('; '));
      }
    }
  } catch {
    // Not JSON; fall through to returning the raw (truncated) text.
  }

  return truncateErrorDetail(trimmed);
}

function truncateErrorDetail(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  const MAX = 200;
  return normalized.length > MAX ? `${normalized.slice(0, MAX - 1)}…` : normalized;
}

function normalizeUser(raw: Record<string, unknown> | undefined): GitHubUser | undefined {
  if (!raw) {
    return undefined;
  }
  const login = asString(raw.login);
  if (!login) {
    return undefined;
  }
  return { login, name: asString(raw.name) };
}

function normalizeIssue(raw: Record<string, unknown>): GitHubIssue {
  const assignees = Array.isArray(raw.assignees) ? raw.assignees as Record<string, unknown>[] : [];
  const labels = Array.isArray(raw.labels) ? raw.labels as Array<Record<string, unknown> | string> : [];

  return {
    id: Number(raw.id ?? 0),
    number: Number(raw.number ?? 0),
    title: asString(raw.title) ?? '',
    state: asString(raw.state) ?? 'open',
    htmlUrl: asString(raw.html_url),
    authorLogin: normalizeUser(raw.user as Record<string, unknown> | undefined)?.login,
    assignees: assignees
      .map(normalizeUser)
      .filter((user): user is GitHubUser => Boolean(user)),
    labels: labels
      .map(label => typeof label === 'string' ? label : asString(label.name))
      .filter((label): label is string => Boolean(label?.trim())),
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
    closedAt: asString(raw.closed_at),
    body: asString(raw.body),
    isPullRequest: Object.hasOwn(raw, 'pull_request'),
    raw
  };
}

function normalizeIssueComment(raw: Record<string, unknown>): GitHubIssueComment {
  const author = normalizeUser(raw.user as Record<string, unknown> | undefined);
  return {
    id: asString(raw.id) ?? '',
    author: author?.name ?? author?.login,
    body: asString(raw.body) ?? '',
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
    raw
  };
}

function normalizeLabel(raw: Record<string, unknown>): GitHubLabel {
  return {
    name: asString(raw.name) ?? '',
    color: asString(raw.color),
    description: asString(raw.description)
  };
}

function normalizeRepo(raw: Record<string, unknown>): GitHubRepo {
  return {
    fullName: asString(raw.full_name) ?? '',
    name: asString(raw.name) ?? '',
    htmlUrl: asString(raw.html_url),
    private: raw.private === true
  };
}

/**
 * Parses the `Link` response header GitHub uses for pagination, e.g.
 * `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`.
 */
export function parseGitHubNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

export class GitHubApiService {
  public constructor(
    private readonly config: GitHubApiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  public async getRepo(): Promise<GitHubRepo> {
    const repo = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/repos/${this.encodeOwnerRepo()}`
    );
    return normalizeRepo(repo);
  }

  public async getCurrentUser(): Promise<GitHubUser> {
    const user = await this.requestJson<Record<string, unknown>>('GET', '/user');
    const normalized = normalizeUser(user);
    if (!normalized) {
      throw new Error('GitHub did not return a valid authenticated user.');
    }
    return normalized;
  }

  public async listLabels(): Promise<GitHubLabel[]> {
    const labels = await this.requestJsonPaginated<Record<string, unknown>>(
      `/repos/${this.encodeOwnerRepo()}/labels`
    );
    return labels.map(normalizeLabel);
  }

  /** All issues (open and closed), pull requests filtered out. */
  public async listIssues(): Promise<GitHubIssue[]> {
    const raw = await this.requestJsonPaginated<Record<string, unknown>>(
      `/repos/${this.encodeOwnerRepo()}/issues`,
      { state: 'all', sort: 'updated', direction: 'desc' }
    );
    return raw.map(normalizeIssue).filter(issue => !issue.isPullRequest);
  }

  public async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const issue = await this.requestJson<Record<string, unknown>>(
      'GET',
      `/repos/${this.encodeOwnerRepo()}/issues/${issueNumber}`
    );
    return normalizeIssue(issue);
  }

  public async createIssue(input: {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<GitHubIssue> {
    const issue = await this.requestJson<Record<string, unknown>>(
      'POST',
      `/repos/${this.encodeOwnerRepo()}/issues`,
      {
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees
      }
    );
    return normalizeIssue(issue);
  }

  public async updateIssue(
    issueNumber: number,
    input: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      labels?: string[];
      assignees?: string[];
    }
  ): Promise<GitHubIssue> {
    const issue = await this.requestJson<Record<string, unknown>>(
      'PATCH',
      `/repos/${this.encodeOwnerRepo()}/issues/${issueNumber}`,
      {
        title: input.title,
        body: input.body,
        state: input.state,
        labels: input.labels,
        assignees: input.assignees
      }
    );
    return normalizeIssue(issue);
  }

  public async listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    const comments = await this.requestJsonPaginated<Record<string, unknown>>(
      `/repos/${this.encodeOwnerRepo()}/issues/${issueNumber}/comments`
    );
    return comments.map(normalizeIssueComment);
  }

  public async addIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.requestJson(
      'POST',
      `/repos/${this.encodeOwnerRepo()}/issues/${issueNumber}/comments`,
      { body: body.trim() }
    );
  }

  private encodeOwnerRepo(): string {
    const owner = this.config.owner.trim();
    const repo = this.config.repo.trim();
    if (!owner || !repo) {
      throw new Error('No GitHub repository is configured.');
    }
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private async requestJsonPaginated<T>(
    pathname: string,
    query?: Record<string, string | undefined>
  ): Promise<T[]> {
    const results: T[] = [];
    let url: string | undefined = this.buildUrl(pathname, { ...query, per_page: '100' }).toString();

    while (url) {
      const result: { data: T[]; nextUrl?: string } = await this.requestJsonWithNextLink<T[]>('GET', url);
      results.push(...result.data);
      url = result.nextUrl;
    }

    return results;
  }

  private buildUrl(pathname: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!value) {
        continue;
      }
      url.searchParams.set(key, value);
    }
    return url;
  }

  private async requestJsonWithNextLink<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: Record<string, unknown>
  ): Promise<{ data: T; nextUrl?: string }> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: body ? JSON.stringify(this.pruneUndefined(body)) : undefined
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(formatGitHubError(response.status, response.statusText, responseText));
    }

    const data = responseText.trim() ? (JSON.parse(responseText) as T) : ([] as T);
    return { data, nextUrl: parseGitHubNextLink(response.headers.get('link')) };
  }

  private pruneUndefined(body: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  }

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathname: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const { data } = await this.requestJsonWithNextLink<T>(method, this.buildUrl(pathname).toString(), body);
    return data;
  }
}
