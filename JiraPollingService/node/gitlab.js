const util = require('node:util');
const { execFile: execFileCallback } = require('node:child_process');

const execFile = util.promisify(execFileCallback);

const DEFAULT_GITLAB_CONFIG = Object.freeze({
  BaseUrl: process.env.GITLAB_URL ?? '',
  Project: process.env.GITLAB_PROJECT ?? '',
  Token: process.env.GITLAB_TOKEN ?? '',
  MaxResults: 100
});

function createGitLabConfig(overrides = {}) {
  return {
    ...DEFAULT_GITLAB_CONFIG,
    ...overrides,
    BaseUrl: overrides.BaseUrl ?? process.env.GITLAB_URL ?? DEFAULT_GITLAB_CONFIG.BaseUrl,
    Project: overrides.Project ?? process.env.GITLAB_PROJECT ?? DEFAULT_GITLAB_CONFIG.Project,
    Token: process.env.GITLAB_TOKEN ?? overrides.Token ?? DEFAULT_GITLAB_CONFIG.Token,
    MaxResults: Number.isInteger(overrides.MaxResults) ? overrides.MaxResults : DEFAULT_GITLAB_CONFIG.MaxResults
  };
}

function normalizeGitLabBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function validateGitLabConfig(config) {
  const baseUrl = normalizeGitLabBaseUrl(config.BaseUrl);
  if (!baseUrl) {
    throw new Error('StandaloneJiraMrPolling:GitLabUrl is required or must be inferable from --repo-path.');
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('StandaloneJiraMrPolling:GitLabUrl must be a valid absolute URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('StandaloneJiraMrPolling:GitLabUrl must use http or https.');
  }

  if (typeof config.Project !== 'string' || config.Project.trim().length === 0) {
    throw new Error('StandaloneJiraMrPolling:GitLabProject is required or must be inferable from --repo-path.');
  }

  if (typeof config.Token !== 'string' || config.Token.trim().length === 0) {
    throw new Error('GITLAB_TOKEN must be supplied via environment variable or StandaloneJiraMrPolling:GitLabToken.');
  }

  if (!Number.isInteger(config.MaxResults) || config.MaxResults < 1 || config.MaxResults > 100) {
    throw new Error('StandaloneJiraMrPolling:MaxResults must be between 1 and 100.');
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createIssueKeyMatcher(issueKey) {
  const escapedKey = escapeRegExp(String(issueKey).trim().toUpperCase());
  return new RegExp(`(^|[^A-Z0-9])${escapedKey}([^A-Z0-9]|$)`, 'i');
}

function mergeRequestMatchesIssueKey(mergeRequest, issueKey) {
  const matcher = createIssueKeyMatcher(issueKey);
  return [mergeRequest?.title, mergeRequest?.description, mergeRequest?.source_branch]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .some(value => matcher.test(value.toUpperCase()));
}

function parseGitLabRemoteUrl(remoteUrl) {
  const trimmed = String(remoteUrl ?? '').trim();
  if (!trimmed) {
    throw new Error('The git remote URL is empty.');
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      baseUrl: `https://${sshMatch[1]}`,
      project: sshMatch[2]
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported git remote URL format: ${trimmed}`);
  }

  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    project: parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '')
  };
}

async function inferGitLabProjectFromRepo(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.trim().length === 0) {
    throw new Error('A repo path is required to infer the GitLab project.');
  }

  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
    cwd: repoPath,
    windowsHide: true
  });

  return parseGitLabRemoteUrl(stdout.trim());
}

function flattenDiscussionNotes(discussions) {
  return discussions
    .flatMap(discussion => {
      const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
      return notes.map(note => ({
        id: String(note.id ?? ''),
        body: String(note.body ?? ''),
        author: note?.author?.username ?? note?.author?.name ?? 'unknown',
        system: note?.system === true,
        createdAt: note?.created_at ?? '',
        updatedAt: note?.updated_at ?? note?.created_at ?? '',
        discussionId: discussion?.id,
        resolvable: note?.resolvable === true,
        resolved: note?.resolved === true
      }));
    })
    .sort((left, right) => {
      const createdComparison = left.createdAt.localeCompare(right.createdAt);
      if (createdComparison !== 0) {
        return createdComparison;
      }

      return left.id.localeCompare(right.id, 'en', { sensitivity: 'base' });
    });
}

class GitLabClient {
  constructor(config, options = {}) {
    validateGitLabConfig(config);
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required for GitLabClient.');
    }
  }

  async requestJson(pathname, query = {}) {
    const baseUrl = normalizeGitLabBaseUrl(this.config.BaseUrl);
    const url = new URL(`${baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': this.config.Token.trim()
      }
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitLab request failed with HTTP ${response.status} (${response.statusText}). Response: ${responseText}`
      );
    }

    if (!responseText.trim()) {
      return [];
    }

    return JSON.parse(responseText);
  }

  async listMergeRequestsForIssue(issueKey, options = {}) {
    const projectId = encodeURIComponent(this.config.Project.trim());
    const search = String(issueKey).trim();
    const state = options.state ?? 'all';
    const mergeRequests = await this.requestJson(`/api/v4/projects/${projectId}/merge_requests`, {
      state,
      search,
      scope: 'all',
      per_page: this.config.MaxResults,
      order_by: 'updated_at',
      sort: 'desc'
    });

    return (Array.isArray(mergeRequests) ? mergeRequests : []).filter(mergeRequest =>
      mergeRequestMatchesIssueKey(mergeRequest, issueKey)
    );
  }

  async listMergeRequestDiscussions(mergeRequestIid) {
    const projectId = encodeURIComponent(this.config.Project.trim());
    const discussions = await this.requestJson(
      `/api/v4/projects/${projectId}/merge_requests/${mergeRequestIid}/discussions`,
      {
        per_page: 100
      }
    );

    return Array.isArray(discussions) ? discussions : [];
  }
}

module.exports = {
  DEFAULT_GITLAB_CONFIG,
  GitLabClient,
  createGitLabConfig,
  createIssueKeyMatcher,
  flattenDiscussionNotes,
  inferGitLabProjectFromRepo,
  mergeRequestMatchesIssueKey,
  normalizeGitLabBaseUrl,
  parseGitLabRemoteUrl,
  validateGitLabConfig
};