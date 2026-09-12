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
import type { CiEvidenceProvider, CiJobSummary, CiRunSummary, CiSecurityReportResult } from './ciEvidenceProvider';
import {
  computeFindingFingerprint,
  type CheckFinding,
  type CheckFindings,
  type CheckFindingSeverity
} from '../workflows/workflowTypes';
import { parseSarif } from '../workflows/checkResultAdapters';

export function redactCiContent(text: string): string {
  return text.replace(/(token|secret|password|bearer|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]+/gi, '$1=[REDACTED]');
}

function normalizeSeverity(raw?: string): CheckFindingSeverity {
  if (!raw) return 'medium';
  const lower = raw.toLowerCase();
  if (lower.includes('crit')) return 'critical';
  if (lower.includes('high') || lower.includes('error')) return 'high';
  if (lower.includes('med') || lower.includes('warn')) return 'medium';
  if (lower.includes('low')) return 'low';
  return 'info';
}

/**
 * Maps an imported GitHub or GitLab security report into unified CheckFindings (TASK-251).
 */
export function mapCiReportToCheckFindings(report: CiSecurityReportResult): CheckFindings {
  if (!report.available || !report.rawReport) {
    return { findings: [], metrics: { issuesFound: 0 } };
  }

  const raw = report.rawReport;

  // 1. If it's a SARIF document
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.runs || parsed.version === '2.1.0') {
        return parseSarif(raw);
      }
    } catch {
      // not JSON string
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.runs) || obj.version === '2.1.0') {
      return parseSarif(JSON.stringify(raw));
    }

    // GitLab SAST / dependency scanning JSON format: { vulnerabilities: [...] }
    if (Array.isArray(obj.vulnerabilities)) {
      const findings: CheckFinding[] = [];
      for (const v of obj.vulnerabilities as Array<Record<string, unknown>>) {
        const file = (v.location as Record<string, unknown> | undefined)?.file as string | undefined;
        const line = (v.location as Record<string, unknown> | undefined)?.start_line as number | undefined;
        const ruleId = (v.id as string) ?? (v.name as string) ?? 'gitlab-sast-vuln';
        const severity = normalizeSeverity(v.severity as string | undefined);
        const rawMsg = (v.description as string) ?? (v.name as string) ?? 'Vulnerability detected';
        const message = redactCiContent(rawMsg);
        const fingerprint = computeFindingFingerprint({ file, line, ruleId, message });

        findings.push({
          fingerprint,
          ruleId,
          severity,
          category: 'security',
          file,
          line,
          message
        });
      }
      return {
        findings,
        metrics: { issuesFound: findings.length }
      };
    }
  }

  // 2. GitHub code scanning alerts array: [{ rule, most_recent_instance, ... }]
  if (Array.isArray(raw)) {
    const findings: CheckFinding[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const rule = item.rule as Record<string, unknown> | undefined;
      const instance = item.most_recent_instance as Record<string, unknown> | undefined;
      const location = instance?.location as Record<string, unknown> | undefined;
      const file = location?.path as string | undefined;
      const line = location?.start_line as number | undefined;

      const ruleId = (rule?.id as string) ?? (rule?.name as string) ?? 'gh-code-scanning';
      const rawSeverity =
        (rule?.security_severity_level as string | undefined) ??
        (rule?.severity as string | undefined) ??
        (instance?.classification as string | undefined);
      const severity = normalizeSeverity(rawSeverity);

      const msgObj = instance?.message as Record<string, unknown> | undefined;
      const rawMsg = (msgObj?.text as string) ?? (rule?.description as string) ?? 'Code scanning finding';
      const message = redactCiContent(rawMsg);
      const fingerprint = computeFindingFingerprint({ file, line, ruleId, message });

      findings.push({
        fingerprint,
        ruleId,
        severity,
        category: 'security',
        file,
        line,
        message
      });
    }
    return {
      findings,
      metrics: { issuesFound: findings.length }
    };
  }

  return { findings: [], metrics: { issuesFound: 0 } };
}

export interface ImportCiSecurityReportInput {
  provider: CiEvidenceProvider;
  sha: string;
  projectId: string;
  at: string;
  signal?: AbortSignal;
}

export interface ImportCiSecurityReportResult {
  ok: boolean;
  findings: CheckFindings;
  report: CiSecurityReportResult;
  bundle?: WorkflowEvidenceBundle;
  error?: string;
}

export async function importCiSecurityReportAsEvidence(
  input: ImportCiSecurityReportInput
): Promise<ImportCiSecurityReportResult> {
  if (!input.provider.getSecurityReports) {
    return {
      ok: false,
      findings: { findings: [], metrics: { issuesFound: 0 } },
      report: { provider: input.provider.kind, runId: '', sha: input.sha, available: false },
      error: `Provider "${input.provider.kind}" does not support security report inspection.`
    };
  }

  try {
    const report = await input.provider.getSecurityReports(input.sha, input.signal);
    const findings = mapCiReportToCheckFindings(report);

    const bundleKey: WorkflowEvidenceBundleKey = {
      projectId: input.projectId,
      runId: `ci-${input.provider.kind}-${report.runId || 'report'}`,
      nodeId: 'security-import',
      attempt: 1
    };

    const bundle = createEvidenceBundle({
      key: bundleKey,
      source: { kind: 'commit', sha: input.sha },
      createdAt: input.at
    });

    return {
      ok: true,
      findings,
      report,
      bundle
    };
  } catch (error) {
    return {
      ok: false,
      findings: { findings: [], metrics: { issuesFound: 0 } },
      report: { provider: input.provider.kind, runId: '', sha: input.sha, available: false },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

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
