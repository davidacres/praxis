import { spawnCheck } from './workflowCheckProcess';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  classifyCheckEnvironmentFailure,
  captureEvidenceEntry,
  commitEvidenceSource,
  createEvidenceBundle,
  evidenceBundleId,
  parseCheckResult,
  redactEvidenceContent,
  unknownEvidenceSource,
  withEvidenceEntry,
  writeEvidenceBundle,
  type CheckFindings,
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
  const result = await spawnCheck(node, cwd, context.signal, line => {
    const progress = checkProgressLine(line);
    if (progress) context.reportProgress?.(progress);
  });

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
  // Redact before this becomes evidence at all — before storage, and before
  // the tail below can land raw in a run's own error text. A check's output
  // can echo a secret from the environment or the command line; nothing
  // downstream (a person's screen today, a diagnosis agent's prompt once
  // FX-BE-052 lands) should see it unredacted.
  const { content: redactedOutput, redacted } = redactEvidenceContent(result.output);
  const { entry, content } = captureEvidenceEntry({
    bundleId: evidenceBundleId(key),
    kind: 'log',
    label: 'combined',
    capturedAt,
    content: spawnFailed ? undefined : redactedOutput,
    missingReason: spawnFailed ? (result.error ?? `Could not start ${node.command}.`) : undefined,
    redacted: spawnFailed ? false : redacted
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

  let parsedFindings: CheckFindings | undefined;
  let adapterError: string | undefined;

  const adapter = node.adapter ?? node.outputs.find(contract => contract.adapter)?.adapter;
  if (adapter && !spawnFailed && !result.timedOut && !result.error) {
    try {
      let rawReport = redactedOutput;
      if (node.reportPath) {
        const fullReportPath = path.resolve(cwd, node.reportPath);
        rawReport = await fs.readFile(fullReportPath, 'utf8');
      }
      parsedFindings = parseCheckResult(adapter, rawReport);
    } catch (err) {
      adapterError = err instanceof Error ? err.message : String(err);
    }
  }

  if (result.timedOut) {
    return { status: 'failed', error: `Check timed out after ${node.timeoutMs}ms.${persistNote}`, artifacts };
  }
  if (spawnFailed) {
    const missing = classifyCheckEnvironmentFailure({ command: node.command, args: node.args, output: '', spawnError: `${result.error ?? ''} ${entry.missingReason ?? ''}` });
    return {
      status: 'failed',
      error: `${entry.missingReason}${missing ? ` ${missing.hint}` : ''}${persistNote}`,
      artifacts: [],
      ...(missing ? { pause: 'environment' as const } : {})
    };
  }
  if (result.error) {
    // Cancellation — the process ran and was stopped; whatever it emitted is
    // still retained above.
    return { status: 'failed', error: `${result.error}${persistNote}`, artifacts };
  }
  if (adapterError) {
    // A report that could not be parsed because the tool itself could not run (an audit
    // against a registry with no audit endpoint, say) is the environment's failure: pause.
    const environment = result.code !== null && !successCodes.includes(result.code)
      ? classifyCheckEnvironmentFailure({ command: node.command, args: node.args, exitCode: result.code, output: redactedOutput })
      : undefined;
    if (environment) {
      return {
        status: 'failed',
        exitCode: result.code ?? undefined,
        error: `${environment.reason} ${environment.hint}${persistNote}`,
        artifacts,
        pause: 'environment' as const
      };
    }
    return {
      status: 'failed',
      exitCode: result.code ?? undefined,
      error: `Failed to parse ${adapter} check report: ${adapterError}${persistNote}`,
      artifacts
    };
  }
  if (result.code !== null && successCodes.includes(result.code)) {
    if (persistError) {
      return { status: 'failed', error: `Check succeeded but its evidence could not be persisted: ${persistError}`, artifacts: [] };
    }
    return { status: 'succeeded', exitCode: result.code, artifacts, ...(parsedFindings ? { findings: parsedFindings } : {}) };
  }

  if (spawnFailed) {
    const isMissing = result.error?.includes('ENOENT') || result.error?.toLowerCase().includes('not found');
    const msg = isMissing
      ? `Scanner binary "${node.command}" not found. Please install it or disable this check node.`
      : (result.error ?? `Could not start ${node.command}.`);
    return {
      status: 'failed',
      exitCode: undefined,
      error: `${msg}${persistNote}`,
      artifacts
    };
  }

  // A non-zero exit is usually the check's verdict. When the output shows the tool itself could not do
  // its job (the registry has no audit endpoint, no network, the command is missing) it is not — pause
  // the run on it instead of failing it and spending the stage's attempt.
  const environment = classifyCheckEnvironmentFailure({
    command: node.command,
    args: node.args,
    exitCode: result.code,
    output: redactedOutput
  });

  return {
    status: 'failed',
    exitCode: result.code ?? undefined,
    // The tail is what a person needs to act; the whole log is in the artifact.
    error: `${environment ? `${environment.reason} ${environment.hint}\n\n` : ''}${node.command} exited ${result.code ?? 'without a code'}${
      redactedOutput.trim() ? `:\n${tail(redactedOutput)}` : '.'
    }${persistNote}`,
    artifacts,
    ...(environment ? { pause: 'environment' as const } : {}),
    ...(parsedFindings ? { findings: parsedFindings } : {})
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
  const failureMarkers = ['\n  1) ', '\n✖ failing tests:', '\nFAIL ', '\nFAILED '];
  for (const marker of failureMarkers) {
    const idx = output.lastIndexOf(marker);
    if (idx !== -1 && output.length - idx <= 12000) {
      return `…${output.slice(idx)}`;
    }
  }
  const limit = 8000;
  return output.length > limit ? `…${output.slice(-limit)}` : output;
}

/**
 * Extracts stable milestones from common test-runner output without making a
 * QA result depend on one runner. Playwright's list reporter emits one line
 * per completed test and a final `passed/failed` summary; other tools simply
 * continue to report their normal evidence log.
 */
function checkProgressLine(line: string): string | undefined {
  const normalized = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!normalized) return undefined;

  const testResult = normalized.match(/^[✓✔✘✗×]\s+(?:\d+\s+)?(.+?)(?:\s+\([^)]*\))?$/);
  if (testResult) {
    const symbol = normalized[0] === '✓' || normalized[0] === '✔' ? 'passed' : 'failed';
    return `QA test ${symbol}: ${testResult[1].trim()}`;
  }

  if (/\b\d+\s+(?:passed|failed|skipped|flaky|timed out|tests?|pass|fail)\b/i.test(normalized)
    && /\b(?:passed|failed|skipped|flaky|timed out|tests?|pass|fail)\b/i.test(normalized)) {
    return `QA summary: ${normalized}`;
  }

  return undefined;
}
