/**
 * Read-only CI evidence provider contract (FX-BE-053 / TASK-138).
 *
 * Resolved independently of a project's issue tracker: a Jira-backed project
 * can still read CI evidence from a GitHub Actions repository, and a folder
 * project can read GitLab CI — tracker, executor and evidence source are
 * separate identities (delivery-debugging-roadmap.md's "Agreed product
 * decisions"). Every provider here is read-only; nothing dispatches, cancels,
 * or re-runs a job.
 *
 * `source` reuses `WorkflowEvidenceSourceRef` (`workflows/workflowEvidence.ts`)
 * deliberately — a CI run's head commit and a local check's captured commit
 * are the same concept (an explicit commit, or explicitly `unknown`), so a CI
 * run can feed `buildDiagnosisBrief` (`ai/diagnosisBrief.ts`) with no
 * conversion once TASK-140 connects the two.
 */

import type { WorkflowEvidenceSourceRef } from '../workflows/workflowEvidence';

export type CiRunConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'unknown';

export interface CiRunSummary {
  /** Provider-specific run id — a GitHub Actions run id, a GitLab pipeline id. */
  runId: string;
  /** 1-based; a run can be re-run, producing further attempts of the same runId. */
  attempt: number;
  source: WorkflowEvidenceSourceRef;
  conclusion: CiRunConclusion;
  htmlUrl?: string;
  createdAt: string;
  workflowName: string;
}

export interface CiJobSummary {
  jobId: string;
  name: string;
  conclusion: CiRunConclusion;
  htmlUrl?: string;
}

export interface CiJobLogResult {
  content: string;
  /** True when the provider reports the log is no longer retrievable (expired retention, deleted artifact) — never thrown as an error. */
  expired: boolean;
}

export interface CiRunPage {
  runs: CiRunSummary[];
  hasMore: boolean;
}

export type CiProviderKind = 'github-actions' | 'gitlab-ci';

/**
 * One page of failed/cancelled runs, jobs for a specific run *attempt* (never
 * "the latest attempt" implicitly), and that attempt's job log. `page` is
 * 1-based throughout.
 */
export interface CiEvidenceProvider {
  readonly kind: CiProviderKind;
  listFailedRuns(page: number, pageSize?: number): Promise<CiRunPage>;
  listJobs(runId: string, attempt: number): Promise<CiJobSummary[]>;
  getJobLog(jobId: string, signal?: AbortSignal): Promise<CiJobLogResult>;
}
