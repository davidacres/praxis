import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createDiagnosisSession,
  importCiRunAsEvidence,
  readEvidenceBundle,
  writeEvidenceBundle,
  type AgentToolMode,
  type CiEvidenceProvider,
  type CiJobSummary,
  type CiRunSummary,
  type CreateDiagnosisSessionResult,
  type DiagnosisSessionPort,
  type WorkflowEvidenceBundleKey
} from '@praxis/core';
import { evidenceStorageRoot } from './workflowEvidenceStorage';

const execFileAsync = promisify(execFile);

/**
 * Connects imported CI evidence to the diagnosis flow (FX-BE-053 / TASK-140).
 *
 * Reuses TASK-139's import and TASK-135's session-starting port as-is; the
 * only new step here is the commit-availability preflight — a CI run's head
 * commit means nothing to a diagnosis session unless it is actually
 * reachable in *this* project's local repository. Checked with a plain
 * `git cat-file -e`, never fetched automatically: pulling a ref implicitly
 * on a project's behalf is exactly the kind of unannounced network mutation
 * this app avoids elsewhere (see the workspace-file secret-stripping and
 * explicit-confirmation conventions in AGENTS.md).
 */

/** Whether `sha` is reachable as a commit in the repository at `cwd`, without fetching it if it is not. */
export async function isCommitAvailable(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export interface StartDiagnosisFromCiImportInput {
  provider: CiEvidenceProvider;
  run: CiRunSummary;
  job: CiJobSummary;
  key: WorkflowEvidenceBundleKey;
  workingDirectory: string | undefined;
  toolMode: AgentToolMode;
}

/**
 * Imports the selected CI job's log as evidence, checks the run's commit is
 * available locally, and — only once both succeed — starts a diagnosis
 * session through `port`, exactly the way `startDiagnosisSessionFromEvidence`
 * (TASK-135) does for a local check's evidence.
 */
export async function startDiagnosisFromCiImport(
  port: DiagnosisSessionPort,
  input: StartDiagnosisFromCiImportInput
): Promise<CreateDiagnosisSessionResult> {
  const imported = await importCiRunAsEvidence({
    provider: input.provider,
    run: input.run,
    job: input.job,
    key: input.key,
    at: new Date().toISOString()
  });
  if (!imported.ok) {
    return { ok: false, reason: 'no-evidence', message: imported.error };
  }

  await writeEvidenceBundle(
    evidenceStorageRoot(),
    imported.bundle,
    imported.content !== undefined ? new Map([[imported.bundle.entries[0].label, imported.content]]) : new Map()
  );

  const revisionAvailable =
    imported.bundle.source.kind === 'commit' && input.workingDirectory
      ? await isCommitAvailable(input.workingDirectory, imported.bundle.source.sha)
      : undefined;

  const { bundle } = await readEvidenceBundle(evidenceStorageRoot(), input.key);
  if (!bundle) {
    return { ok: false, reason: 'no-evidence', message: 'The imported evidence could not be read back after writing it.' };
  }

  return createDiagnosisSession(port, {
    bundle,
    node: { command: input.job.name, args: [], successExitCodes: [0] },
    workingDirectory: input.workingDirectory,
    toolMode: input.toolMode,
    evidenceContent: imported.content !== undefined ? { [imported.bundle.entries[0].label]: imported.content } : {},
    revisionAvailable,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  });
}
