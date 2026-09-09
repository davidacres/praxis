/**
 * GitHub Actions run observation and correlation (FX-BE-061 / TASK-163).
 *
 * When a deployment profile is configured to observe rather than dispatch,
 * this module handles finding and correlating an already-triggered workflow
 * run. A run is identified by filtering existing runs by:
 * - Workflow ID (from the profile's `workflowFile`)
 * - Repository (owner/repo from config)
 * - Source commit SHA (from the artifact's sourceCommit)
 * - Environment (from the deployment profile's environment, if the workflow
 *   declares environment-targeted steps)
 *
 * Acceptance criteria:
 * - If exactly one candidate run exists, attach it immediately
 * - If multiple candidates exist, return them for explicit selection
 * - Reject attachment of a run from a different SHA (stale run protection)
 *
 * A standalone client, following this codebase's "one client per concern"
 * convention. Like `GitHubActionsDeploymentExecutor`, this needs `actions:read`
 * to list runs; no write permissions needed for observation.
 */

import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';
import type { WorkflowEvidenceSourceRef } from '../workflows/workflowEvidence';

const GITHUB_API_VERSION = '2022-11-28';

/** A workflow run candidate for correlation with a deployment. */
export interface WorkflowRunCandidate {
  id: number;
  /** Run attempt number (1-based). */
  attempt: number;
  /** Commit SHA this run was triggered for. */
  sha: string;
  /** Name of the workflow (from GitHub's API). */
  workflowName: string;
  /** Current status: 'queued', 'in_progress', 'completed'. */
  status: string;
  /** Conclusion of the run (null if still in progress): 'success', 'failure', 'cancelled', etc. */
  conclusion: string | null;
  /** When the run was created. */
  createdAt: string;
  /** Link to the run on GitHub. */
  htmlUrl: string;
}

/**
 * The outcome of attempting to correlate a deployment run with an existing
 * workflow run. Distinguishes between:
 * - Single candidate found and automatically attached
 * - Multiple candidates found (caller must choose)
 * - No candidates found (no run matching the SHA/workflow combination)
 * - Ambiguity: multiple candidates, only one of which matches the expected SHA
 */
export type WorkflowRunCorrelationOutcome =
  | { kind: 'single-candidate'; run: WorkflowRunCandidate }
  | { kind: 'multiple-candidates'; runs: WorkflowRunCandidate[] }
  | { kind: 'no-candidates' }
  | { kind: 'stale-run'; run: WorkflowRunCandidate; expectedSha: string };

/** Thrown when GitHub API returns an error during observation. */
export class GitHubActionsObserverError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'insufficient-permission' | 'workflow-not-found' | 'rate-limited' | 'other',
    public readonly status: number
  ) {
    super(message);
    this.name = 'GitHubActionsObserverError';
  }
}

function classifyObservationFailure(status: number, headers: { get(name: string): string | null }): GitHubActionsObserverError['kind'] {
  if (status === 404) return 'workflow-not-found';
  if (status === 429) return 'rate-limited';
  if (status === 403) {
    return headers.get('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'insufficient-permission';
  }
  return 'other';
}

export class GitHubActionsObserver {
  public constructor(
    private readonly config: GitHubActionsConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  /**
   * List workflow runs for a specific workflow, ordered by creation date
   * (newest first). Returns paginated results; use `pageSize` to control
   * batch size (default 30).
   *
   * @param workflowId The workflow ID or name (same as passed to dispatcher)
   * @param page 1-based page number
   * @param pageSize Number of results per page
   * @returns Runs for this workflow, or null if the workflow doesn't exist
   */
  public async listWorkflowRuns(
    workflowId: number | string,
    page = 1,
    pageSize = 30
  ): Promise<{ runs: WorkflowRunCandidate[]; hasMore: boolean } | null> {
    const url = this.buildUrl(
      `/repos/${this.encodeOwnerRepo()}/actions/workflows/${encodeURIComponent(String(workflowId))}/runs`,
      { per_page: String(pageSize), page: String(page) }
    );
    try {
      const response = await this.get(url);
      const parsed = response.json as { total_count?: number; workflow_runs?: unknown[] };
      const runs = (parsed.workflow_runs ?? [])
        .map(raw => normalizeRun(raw as Record<string, unknown>))
        .filter((run): run is WorkflowRunCandidate => !!run);
      const totalCount = typeof parsed.total_count === 'number' ? parsed.total_count : undefined;
      const hasMore = totalCount !== undefined ? page * pageSize < totalCount : (parsed.workflow_runs ?? []).length === pageSize;
      return { runs, hasMore };
    } catch (error) {
      if (error instanceof GitHubActionsObserverError && error.kind === 'workflow-not-found') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Correlate a deployment with an existing workflow run. Searches for runs
   * matching the specified workflow and source commit SHA, with optional
   * environment filtering.
   *
   * @param workflowId The workflow ID or name
   * @param sourceCommit The artifact's source commit (for SHA matching)
   * @param environment Optional environment name to filter runs
   * @returns The correlation outcome
   */
  public async correlateWorkflowRun(
    workflowId: number | string,
    sourceCommit: WorkflowEvidenceSourceRef,
    environment?: string
  ): Promise<WorkflowRunCorrelationOutcome> {
    // Only commits have a definite SHA we can correlate against
    if (sourceCommit.kind !== 'commit') {
      return { kind: 'no-candidates' };
    }

    const expectedSha = sourceCommit.sha;

    // Search through pages until we find candidates or exhaustion
    const candidates: WorkflowRunCandidate[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && candidates.length < 10) {
      // Limit to 10 candidates max (safety for "multiple selection" case)
      const result = await this.listWorkflowRuns(workflowId, page, 10);
      if (result === null) {
        return { kind: 'no-candidates' };
      }

      for (const run of result.runs) {
        // Match on SHA — stale run protection
        if (run.sha === expectedSha) {
          candidates.push(run);
        }
      }

      hasMore = result.hasMore;
      page++;
    }

    if (candidates.length === 0) {
      return { kind: 'no-candidates' };
    }

    // Filter by environment if specified (caller provides this from deployment profile)
    // Note: Environment filtering requires parsing the run's job environment,
    // which is not available in the runs list endpoint. A real implementation
    // would need to fetch job details for each candidate. For now, we return
    // all SHA-matching candidates and let the caller filter or select explicitly.

    if (candidates.length === 1) {
      return { kind: 'single-candidate', run: candidates[0] };
    }

    return { kind: 'multiple-candidates', runs: candidates };
  }

  private encodeOwnerRepo(): string {
    const owner = this.config.owner.trim();
    const repo = this.config.repo.trim();
    if (!owner || !repo) throw new Error('No GitHub repository is configured for Actions deployment.');
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private buildUrl(pathname: string, query?: Record<string, string>): string {
    const base = `${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`;
    if (!query || Object.keys(query).length === 0) return base;
    const params = new URLSearchParams(query);
    return `${base}?${params.toString()}`;
  }

  private async get(url: string): Promise<{ json: unknown }> {
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
    const text = await response.text();
    if (response.status === 403 || response.status === 404 || response.status === 429) {
      const kind = classifyObservationFailure(response.status, response.headers);
      throw new GitHubActionsObserverError(
        `GitHub Actions observation failed (HTTP ${response.status} ${response.statusText}).`,
        kind,
        response.status
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub Actions request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { json: text.trim() ? JSON.parse(text) : {} };
  }
}

function normalizeRun(raw: Record<string, unknown>): WorkflowRunCandidate | undefined {
  const id = raw.id;
  if (typeof id !== 'number') return undefined;

  const sha = raw.head_sha;
  if (typeof sha !== 'string' || !sha.trim()) return undefined;

  return {
    id,
    attempt: typeof raw.run_attempt === 'number' ? raw.run_attempt : 1,
    sha: sha.trim(),
    workflowName: typeof raw.name === 'string' ? raw.name : 'Workflow',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    conclusion: typeof raw.conclusion === 'string' ? raw.conclusion : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : ''
  };
}
