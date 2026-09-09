/**
 * GitLab CI read-only evidence provider (FX-BE-053 / TASK-138).
 *
 * Mirrors `githubActionsEvidenceProvider.ts` — see its module doc for why
 * this is a self-contained client rather than sharing `GitLabApiService`'s
 * private request machinery. `token` needs only `read_api` scope.
 *
 * GitLab models this differently from GitHub Actions: a "run" here is a
 * pipeline, and a re-run creates a *new* pipeline id rather than a further
 * attempt of the same one — so `attempt` is always 1 for GitLab, kept on
 * `CiRunSummary` only so the shared `CiEvidenceProvider` contract stays one
 * shape for both providers.
 */

import type { CiEvidenceProvider, CiJobLogResult, CiJobSummary, CiRunConclusion, CiRunPage, CiRunSummary } from './ciEvidenceProvider';

const KNOWN_CONCLUSIONS: readonly string[] = ['success', 'failed', 'canceled', 'skipped'];
const FAILURE_STATUSES: readonly string[] = ['failed', 'canceled'];

export interface GitLabCiConfig {
  baseUrl: string;
  projectPath: string;
  token: string;
}

function normalizeConclusion(status: unknown): CiRunConclusion {
  if (status === 'failed') return 'failure';
  if (status === 'canceled') return 'cancelled';
  return typeof status === 'string' && KNOWN_CONCLUSIONS.includes(status) ? (status as CiRunConclusion) : 'unknown';
}

function normalizeRun(raw: Record<string, unknown>): CiRunSummary | undefined {
  const id = raw.id;
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  const sha = raw.sha;
  return {
    runId: String(id),
    attempt: 1,
    source: typeof sha === 'string' && sha.trim() ? { kind: 'commit', sha: sha.trim() } : { kind: 'unknown' },
    conclusion: normalizeConclusion(raw.status),
    ...(typeof raw.web_url === 'string' ? { htmlUrl: raw.web_url } : {}),
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
    workflowName: typeof raw.name === 'string' ? raw.name : typeof raw.ref === 'string' ? raw.ref : 'Pipeline'
  };
}

function normalizeJob(raw: Record<string, unknown>): CiJobSummary | undefined {
  const id = raw.id;
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  return {
    jobId: String(id),
    name: typeof raw.name === 'string' ? raw.name : 'Job',
    conclusion: normalizeConclusion(raw.status),
    ...(typeof raw.web_url === 'string' ? { htmlUrl: raw.web_url } : {})
  };
}

export class GitLabCiEvidenceProvider implements CiEvidenceProvider {
  public readonly kind = 'gitlab-ci' as const;

  public constructor(
    private readonly config: GitLabCiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  public async listFailedRuns(page: number, pageSize = 30): Promise<CiRunPage> {
    const url = this.buildUrl(`/projects/${this.encodeProjectPath()}/pipelines`, {
      per_page: String(pageSize),
      page: String(page),
      status: 'failed'
    });
    const { data, headers } = await this.get<unknown[]>(url);
    const runs = data.map(raw => normalizeRun(raw as Record<string, unknown>)).filter((run): run is CiRunSummary => !!run);
    const nextPage = headers.get('x-next-page')?.trim();
    return { runs, hasMore: !!nextPage };
  }

  /** GitLab has no re-run-in-place attempt concept, so `attempt` is accepted for contract symmetry and otherwise ignored. */
  public async listJobs(runId: string, _attempt: number): Promise<CiJobSummary[]> {
    const url = this.buildUrl(`/projects/${this.encodeProjectPath()}/pipelines/${encodeURIComponent(runId)}/jobs`, {
      per_page: '100'
    });
    const { data } = await this.get<unknown[]>(url);
    return data.map(raw => normalizeJob(raw as Record<string, unknown>)).filter((job): job is CiJobSummary => !!job);
  }

  public async getJobLog(jobId: string, signal?: AbortSignal): Promise<CiJobLogResult> {
    const url = this.buildUrl(`/projects/${this.encodeProjectPath()}/jobs/${encodeURIComponent(jobId)}/trace`);
    const response = await this.fetchImpl(url, { signal, headers: { 'PRIVATE-TOKEN': this.config.token } });
    // A trace GitLab has already expired off job-log retention reads 404.
    if (response.status === 404) return { content: '', expired: true };
    if (response.status === 403) {
      throw new Error('No permission to read this job’s trace (HTTP 403). The token needs read_api.');
    }
    if (!response.ok) {
      throw new Error(`GitLab CI trace request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { content: await response.text(), expired: false };
  }

  private encodeProjectPath(): string {
    const path = this.config.projectPath.trim();
    if (!path) throw new Error('No GitLab project is configured for CI evidence.');
    return encodeURIComponent(path);
  }

  private buildUrl(pathname: string, query?: Record<string, string>): string {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }

  private async get<T>(url: string): Promise<{ data: T; headers: Headers }> {
    const response = await this.fetchImpl(url, { headers: { 'PRIVATE-TOKEN': this.config.token } });
    const text = await response.text();
    if (response.status === 403 || response.status === 404) {
      throw new Error(`No permission to read pipelines for this project (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`GitLab CI request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { data: (text.trim() ? JSON.parse(text) : []) as T, headers: response.headers };
  }
}
