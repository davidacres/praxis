/**
 * GitHub Actions read-only evidence provider (FX-BE-053 / TASK-138).
 *
 * A standalone client — deliberately not sharing `GitHubApiService`'s private
 * request machinery, matching this codebase's existing convention of one
 * self-contained client per concern (`GitHubApiService` for issues,
 * `GitLabApiService` for GitLab issues/MRs, this one for Actions) rather than
 * a shared HTTP layer. `token` needs only `actions:read` /
 * `contents:read` — see `ciEvidenceProvider.ts`'s module doc for why this
 * stays independent of whatever token the project's issue tracker uses.
 */

import type { CiEvidenceProvider, CiJobLogResult, CiJobSummary, CiRunConclusion, CiRunPage, CiRunSummary } from './ciEvidenceProvider';

const GITHUB_API_VERSION = '2022-11-28';
const KNOWN_CONCLUSIONS: readonly string[] = ['success', 'failure', 'cancelled', 'timed_out', 'action_required'];
/** Conclusions that represent a *failure worth diagnosing* — a run still in progress has none of these yet. */
const FAILURE_CONCLUSIONS: readonly CiRunConclusion[] = ['failure', 'cancelled', 'timed_out'];

export interface GitHubActionsConfig {
  /** `https://api.github.com` for github.com, or a GitHub Enterprise Server host. */
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
}

function normalizeConclusion(value: unknown): CiRunConclusion {
  return typeof value === 'string' && KNOWN_CONCLUSIONS.includes(value) ? (value as CiRunConclusion) : 'unknown';
}

function normalizeRun(raw: Record<string, unknown>): CiRunSummary | undefined {
  const runId = raw.id;
  if (typeof runId !== 'number' && typeof runId !== 'string') return undefined;
  const sha = raw.head_sha;
  return {
    runId: String(runId),
    attempt: typeof raw.run_attempt === 'number' ? raw.run_attempt : 1,
    source: typeof sha === 'string' && sha.trim() ? { kind: 'commit', sha: sha.trim() } : { kind: 'unknown' },
    conclusion: normalizeConclusion(raw.conclusion),
    ...(typeof raw.html_url === 'string' ? { htmlUrl: raw.html_url } : {}),
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
    workflowName: typeof raw.name === 'string' ? raw.name : 'Workflow'
  };
}

function normalizeJob(raw: Record<string, unknown>): CiJobSummary | undefined {
  const jobId = raw.id;
  if (typeof jobId !== 'number' && typeof jobId !== 'string') return undefined;
  return {
    jobId: String(jobId),
    name: typeof raw.name === 'string' ? raw.name : 'Job',
    conclusion: normalizeConclusion(raw.conclusion),
    ...(typeof raw.html_url === 'string' ? { htmlUrl: raw.html_url } : {})
  };
}

export class GitHubActionsEvidenceProvider implements CiEvidenceProvider {
  public readonly kind = 'github-actions' as const;

  public constructor(
    private readonly config: GitHubActionsConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  public async listFailedRuns(page: number, pageSize = 30): Promise<CiRunPage> {
    const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/runs`, {
      per_page: String(pageSize),
      page: String(page)
    });
    const response = await this.get(url);
    const parsed = response.json as { total_count?: number; workflow_runs?: unknown[] };
    const runs = (parsed.workflow_runs ?? [])
      .map(raw => normalizeRun(raw as Record<string, unknown>))
      .filter((run): run is CiRunSummary => !!run && FAILURE_CONCLUSIONS.includes(run.conclusion));
    const totalCount = typeof parsed.total_count === 'number' ? parsed.total_count : undefined;
    const hasMore = totalCount !== undefined ? page * pageSize < totalCount : (parsed.workflow_runs ?? []).length === pageSize;
    return { runs, hasMore };
  }

  /** Jobs for one specific run *attempt* — never "whatever attempt is latest now". */
  public async listJobs(runId: string, attempt: number): Promise<CiJobSummary[]> {
    const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/runs/${encodeURIComponent(runId)}/attempts/${attempt}/jobs`);
    const response = await this.get(url);
    const parsed = response.json as { jobs?: unknown[] };
    return (parsed.jobs ?? []).map(raw => normalizeJob(raw as Record<string, unknown>)).filter((job): job is CiJobSummary => !!job);
  }

  public async getJobLog(jobId: string): Promise<CiJobLogResult> {
    const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/jobs/${encodeURIComponent(jobId)}/logs`);
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
    // A log past its retention window, or an artifact GitHub has already
    // reaped, reads as 404/410 — an explicit expired state, not an error.
    if (response.status === 404 || response.status === 410) {
      return { content: '', expired: true };
    }
    if (response.status === 403) {
      throw new Error('No permission to read this job’s log (HTTP 403). The token needs actions:read.');
    }
    if (!response.ok) {
      throw new Error(`GitHub Actions log request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { content: await response.text(), expired: false };
  }

  private encodeOwnerRepo(): string {
    const owner = this.config.owner.trim();
    const repo = this.config.repo.trim();
    if (!owner || !repo) throw new Error('No GitHub repository is configured for CI evidence.');
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private buildUrl(pathname: string, query?: Record<string, string>): string {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
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
      throw new Error(`No permission to read Actions runs for this repository (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`GitHub Actions request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { json: text.trim() ? JSON.parse(text) : {} };
  }
}
