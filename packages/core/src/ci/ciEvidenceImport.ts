/**
 * Import a selected CI job's log into the evidence store (FX-BE-053 / TASK-139).
 *
 * Reuses TASK-132's capture/storage exactly — an imported log gets the same
 * truncation, presence and retention treatment a locally captured one does,
 * and the same deterministic bundle id (`evidenceBundleId`) means retrying an
 * import overwrites rather than duplicates the bundle.
 */

import {
  captureEvidenceEntry,
  createEvidenceBundle,
  evidenceBundleId,
  withEvidenceEntry,
  type WorkflowEvidenceBundle,
  type WorkflowEvidenceBundleKey
} from '../workflows/workflowEvidence';
import type { CiEvidenceProvider, CiJobSummary, CiRunSummary } from './ciEvidenceProvider';

export interface ImportCiRunInput {
  provider: CiEvidenceProvider;
  run: CiRunSummary;
  job: CiJobSummary;
  /**
   * Identifies the bundle this import writes to. Callers key `runId`/`attempt`
   * from the *CI* run/attempt being imported (e.g. `ci-github-actions-<runId>`),
   * never from a local workflow run — re-importing the same CI attempt must
   * resolve to the same key so it overwrites rather than duplicates.
   */
  key: WorkflowEvidenceBundleKey;
  at: string;
  signal?: AbortSignal;
  maxBytes?: number;
}

export type ImportCiRunResult =
  | { ok: true; bundle: WorkflowEvidenceBundle; content?: string }
  | { ok: false; error: string };

/**
 * Fetches the job's log and turns it into a bundle ready for
 * `writeEvidenceBundle`. A provider error (permission, network, cancellation)
 * is returned verbatim as `{ ok: false, error }` — never swallowed into a
 * generic failure — and an *expired* log (the provider itself says so, not an
 * error) becomes explicit `missing` evidence with a stated reason, the same
 * vocabulary a local capture already uses for "nothing was captured".
 */
export async function importCiRunAsEvidence(input: ImportCiRunInput): Promise<ImportCiRunResult> {
  let log: { content: string; expired: boolean };
  try {
    log = await input.provider.getJobLog(input.job.jobId, input.signal);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(input.key),
    kind: 'log',
    label: input.job.name,
    capturedAt: input.at,
    content: log.expired ? undefined : log.content,
    missingReason: log.expired ? 'This log has expired on the CI provider and can no longer be retrieved.' : undefined,
    maxBytes: input.maxBytes
  });

  const sourceUrl = input.job.htmlUrl ?? input.run.htmlUrl;
  const bundle = withEvidenceEntry(
    createEvidenceBundle({
      key: input.key,
      source: input.run.source,
      createdAt: input.at,
      ...(sourceUrl ? { sourceUrl } : {})
    }),
    entry
  );

  return { ok: true, bundle, content };
}

/**
 * The evidence-store key for one CI run attempt, kept separate from any local
 * workflow run's own key namespace so a CI import can never collide with, or
 * be mistaken for, a locally captured attempt.
 */
export function ciEvidenceKey(projectId: string, provider: CiEvidenceProvider['kind'], run: CiRunSummary, jobId: string): WorkflowEvidenceBundleKey {
  return {
    projectId,
    runId: `ci-${provider}-${run.runId}`,
    nodeId: jobId,
    attempt: run.attempt
  };
}
