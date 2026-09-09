/**
 * GitHub Actions run results mapping (FX-BE-061 / TASK-164).
 *
 * Maps jobs and results from an observed/dispatched workflow run, with:
 * - Job listing and status inspection
 * - Log fetching with bounded backoff for transient failures (expired logs,
 *   temporary API errors)
 * - Separation of workflow success from deployment health (a workflow can
 *   succeed but the deployed app be unhealthy, or vice versa)
 * - Provider URL recording for the workflow run and individual jobs
 *
 * A standalone client, reusing `GitHubActionsConfig` shape from the evidence
 * provider but kept independent for clean separation of concerns (this is
 * deployment-focused result mapping, not CI evidence collection).
 */

import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';

const GITHUB_API_VERSION = '2022-11-28';

/** Summary of a single job in a workflow run. */
export interface WorkflowJobResult {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
}

/** The result of fetching logs for a job. */
export interface JobLogFetch {
  jobId: number;
  content: string;
  expired: boolean;
  error?: string;
}

/**
 * The outcome of observing/mapping results from a workflow run.
 * Separates workflow execution state from health/readiness interpretation.
 */
export interface WorkflowRunResults {
  /** The run ID (for recording as external reference). */
  runId: number;
  /** URL to view the run on GitHub. */
  htmlUrl: string;
  /** Workflow run status: completed/in_progress/queued. */
  runStatus: string;
  /** Workflow conclusion (final outcome if completed): success/failure/cancelled/null. */
  runConclusion: string | null;
  /** Jobs in this run. */
  jobs: WorkflowJobResult[];
  /** True if any job failed or the workflow was cancelled (workflow did not succeed). */
  workflowFailed: boolean;
  /** Provider-recorded URLs (workflow run URL, artifact URLs if any). */
  providerUrls: { workflowRunUrl: string; jobUrls: Map<number, string> };
}

/**
 * Thrown when result mapping encounters an unrecoverable error
 * (not transient failures like expired logs or rate limits).
 */
export class GitHubActionsResultsError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'insufficient-permission' | 'run-not-found' | 'other',
    public readonly status?: number
  ) {
    super(message);
    this.name = 'GitHubActionsResultsError';
  }
}

/** Configuration for backoff retries when fetching logs. */
export interface BackoffConfig {
  /** Maximum number of retry attempts. */
  maxAttempts?: number;
  /** Base delay in milliseconds. */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds. */
  maxDelayMs?: number;
}

export class GitHubActionsResults {
  public constructor(
    private readonly config: GitHubActionsConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  /**
   * Fetch job details for a specific workflow run.
   * Returns normalized job results with status and URLs.
   */
  public async getRunJobs(runId: number, attempt: number = 1): Promise<WorkflowJobResult[]> {
    const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/runs/${runId}/attempts/${attempt}/jobs`);
    const response = await this.get(url);
    const parsed = response.json as { jobs?: unknown[] };

    return (parsed.jobs ?? [])
      .map(raw => normalizeJob(raw as Record<string, unknown>))
      .filter((job): job is WorkflowJobResult => !!job);
  }

  /**
   * Fetch the complete set of results for a workflow run, including job
   * details. The run itself must have been previously fetched to obtain the
   * necessary metadata.
   *
   * This does NOT fetch individual job logs — that's handled separately by
   * `fetchJobLog()` with its own backoff/retry logic to handle expired logs.
   */
  public async getRunResults(runId: number, runStatus: string, runConclusion: string | null, htmlUrl: string): Promise<WorkflowRunResults> {
    const jobs = await this.getRunJobs(runId);

    return {
      runId,
      htmlUrl,
      runStatus,
      runConclusion,
      jobs,
      workflowFailed: runConclusion !== 'success' && runConclusion !== null,
      providerUrls: {
        workflowRunUrl: htmlUrl,
        jobUrls: new Map(jobs.map(j => [j.id, j.htmlUrl]))
      }
    };
  }

  /**
   * Fetch logs for a single job with bounded backoff for transient failures.
   *
   * Transient failures (429 rate limit, 500 server error, 503 temporary
   * unavailability) are retried with exponential backoff. Permanent failures
   * (404/410 expired logs, 403 permission denied) are returned as such.
   *
   * @param jobId The job ID to fetch logs for
   * @param config Backoff configuration (maxAttempts, delays)
   * @returns Job logs with expired flag, error if unrecoverable
   */
  public async fetchJobLog(jobId: number, config?: BackoffConfig): Promise<JobLogFetch> {
    const maxAttempts = config?.maxAttempts ?? 3;
    const initialDelayMs = config?.initialDelayMs ?? 1000;
    const maxDelayMs = config?.maxDelayMs ?? 30000;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/jobs/${jobId}/logs`);
        const response = await this.fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.config.token}`,
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        });

        // Expired logs: 404 or 410 (permanent failure, don't retry)
        if (response.status === 404 || response.status === 410) {
          return { jobId, content: '', expired: true };
        }

        // Permission error (permanent, don't retry)
        if (response.status === 403) {
          return {
            jobId,
            content: '',
            expired: false,
            error: 'No permission to read logs (HTTP 403). Token needs actions:read.'
          };
        }

        // Success
        if (response.ok) {
          const content = await response.text();
          return { jobId, content, expired: false };
        }

        // Transient failures: 429, 5xx (retry with backoff)
        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          lastError = new Error(`GitHub API returned HTTP ${response.status} (transient, will retry)`);

          if (attempt < maxAttempts) {
            // Exponential backoff: 1s, 2s, 4s, up to maxDelayMs
            const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            await this.delay(delayMs);
            continue;
          }
          // If at max attempts, break out and return the "after N attempts" error below
          break;
        }

        // Other errors (4xx excluding 403, other 5xx after retries exhausted)
        return {
          jobId,
          content: '',
          expired: false,
          error: `GitHub API returned HTTP ${response.status} ${response.statusText}`
        };
      } catch (error) {
        // Network-level errors: retry with backoff
        if (error instanceof Error && this.isTransientNetworkError(error.message)) {
          lastError = error;

          if (attempt < maxAttempts) {
            const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            await this.delay(delayMs);
            continue;
          }
        }

        // Non-transient error (e.g., invalid URL, unexpected exception)
        return {
          jobId,
          content: '',
          expired: false,
          error: `Unexpected error fetching logs: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }

    // All retries exhausted for transient error
    return {
      jobId,
      content: '',
      expired: false,
      error: `Failed to fetch logs after ${maxAttempts} attempts: ${lastError?.message ?? 'Unknown error'}`
    };
  }

  private encodeOwnerRepo(): string {
    const owner = this.config.owner.trim();
    const repo = this.config.repo.trim();
    if (!owner || !repo) throw new Error('No GitHub repository is configured for Actions results.');
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private buildUrl(pathname: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`;
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

    if (response.status === 403 || response.status === 404) {
      const kind = response.status === 404 ? 'run-not-found' : 'insufficient-permission';
      throw new GitHubActionsResultsError(
        `GitHub Actions results request failed (HTTP ${response.status}).`,
        kind,
        response.status
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub Actions results request failed (HTTP ${response.status} ${response.statusText}).`);
    }

    return { json: text.trim() ? JSON.parse(text) : {} };
  }

  private isTransientNetworkError(message: string): boolean {
    const transientPatterns = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'socket hang up'];
    return transientPatterns.some(pattern => message.includes(pattern));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function normalizeJob(raw: Record<string, unknown>): WorkflowJobResult | undefined {
  const id = raw.id;
  if (typeof id !== 'number') return undefined;

  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `job-${id}`,
    status: (typeof raw.status === 'string' && ['queued', 'in_progress', 'completed'].includes(raw.status)
      ? raw.status
      : 'queued') as 'queued' | 'in_progress' | 'completed',
    conclusion: typeof raw.conclusion === 'string' ? (raw.conclusion as any) : null,
    startedAt: typeof raw.started_at === 'string' ? raw.started_at : null,
    completedAt: typeof raw.completed_at === 'string' ? raw.completed_at : null,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : ''
  };
}
