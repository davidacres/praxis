import { spawnCheck } from './workflowCheckProcess';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  captureEvidenceEntry,
  commitEvidenceSource,
  createEvidenceBundle,
  evidenceBundleId,
  unknownEvidenceSource,
  withEvidenceEntry,
  writeEvidenceBundle,
  type StageDispatchContext,
  type StageOutcome,
  type WorkflowCheckNode,
  type WorkflowEvidenceBundleKey,
  type WorkflowEvidenceSourceRef
} from '@praxis/core';

/**
 * Deterministic check execution (FX-BE-024 / TASK-112), retaining failure
 * evidence even when the process times out or never starts (FX-BE-051 /
 * TASK-133).
 *
 * A check's exit code decides its outcome — no model is involved, which is
 * exactly why a QA or security gate can rest on one. Output is captured
 * through `workflowEvidence.ts` and reported as the node's declared artifact,
 * so a reviewer can read what the check actually said. Deliberately free of
 * any `electron` import — `evidenceStorageRoot` (which needs
 * `app.getPath('userData')`) lives in `workflowOrchestratorInstance.ts` and is
 * passed in, the same way `fallbackCwd` already is, so this file runs under
 * plain `node --test` like `workflowCheckProcess.ts` does.
 */

const OUTPUT_TAIL = 4000;
const execFileAsync = promisify(execFile);

export async function runWorkflowCheck(
  node: WorkflowCheckNode,
  context: StageDispatchContext,
  fallbackCwd: string | undefined,
  evidenceRoot: string
): Promise<StageOutcome> {
  const cwd = context.worktreePath ?? fallbackCwd;
  if (!cwd) {
    return { status: 'failed', error: 'This check has no working directory; attach a folder to the project.' };
  }
  if (!node.command.trim()) {
    return { status: 'failed', error: 'This check has no command.' };
  }

  const successCodes = node.successExitCodes?.length ? node.successExitCodes : [0];
  const capturedAt = new Date().toISOString();
  const result = await spawnCheck(node, cwd, context.signal);

  const key: WorkflowEvidenceBundleKey = {
    projectId: context.run.projectId,
    runId: context.run.runId,
    nodeId: node.id,
    attempt: Math.max(1, context.run.nodes[node.id]?.attempts.length ?? 1)
  };

  // The only case nothing ran at all: the process itself never started.
  // Cancellation and a timeout both mean the check *did* run — whatever it
  // emitted before being stopped is genuine evidence, not a missing capture.
  const spawnFailed = result.code === null && !result.timedOut && !context.signal?.aborted;
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(key),
    kind: 'log',
    label: 'combined',
    capturedAt,
    content: spawnFailed ? undefined : result.output,
    missingReason: spawnFailed ? (result.error ?? `Could not start ${node.command}.`) : undefined
  });

  const source = await resolveEvidenceSource(cwd);
  const bundle = withEvidenceEntry(createEvidenceBundle({ key, source, createdAt: capturedAt }), entry);

  let persistError: string | undefined;
  let entryFilePath: string | undefined;
  try {
    const manifestPath = await writeEvidenceBundle(
      evidenceRoot,
      bundle,
      content !== undefined ? new Map([[entry.label, content]]) : new Map()
    );
    if (entry.presence === 'present') entryFilePath = path.join(path.dirname(manifestPath), entry.path as string);
  } catch (error) {
    // Output-write failure cannot masquerade as complete evidence: nothing is
    // referenced from a bundle that failed to reach disk, whatever it captured.
    persistError = error instanceof Error ? error.message : String(error);
  }

  const persistNote = persistError ? ` (evidence not persisted: ${persistError})` : '';
  const artifacts = entryFilePath
    ? node.outputs.map(contract => ({ contractId: contract.id, kind: contract.kind, path: entryFilePath }))
    : [];

  if (result.timedOut) {
    return { status: 'failed', error: `Check timed out after ${node.timeoutMs}ms.${persistNote}`, artifacts };
  }
  if (spawnFailed) {
    return { status: 'failed', error: `${entry.missingReason}${persistNote}`, artifacts: [] };
  }
  if (result.error) {
    // Cancellation — the process ran and was stopped; whatever it emitted is
    // still retained above.
    return { status: 'failed', error: `${result.error}${persistNote}`, artifacts };
  }
  if (result.code !== null && successCodes.includes(result.code)) {
    if (persistError) {
      return { status: 'failed', error: `Check succeeded but its evidence could not be persisted: ${persistError}`, artifacts: [] };
    }
    return { status: 'succeeded', exitCode: result.code, artifacts };
  }

  return {
    status: 'failed',
    exitCode: result.code ?? undefined,
    // The tail is what a person needs to act; the whole log is in the artifact.
    error: `${node.command} exited ${result.code ?? 'without a code'}${
      result.output.trim() ? `:\n${tail(result.output)}` : '.'
    }${persistNote}`,
    artifacts
  };
}

/** Best-effort HEAD lookup. No repository, no git, or a bare/unborn tree all fall back to `unknown` rather than guessing. */
async function resolveEvidenceSource(cwd: string): Promise<WorkflowEvidenceSourceRef> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = stdout.trim();
    return sha ? commitEvidenceSource(sha) : unknownEvidenceSource();
  } catch {
    return unknownEvidenceSource();
  }
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
}
