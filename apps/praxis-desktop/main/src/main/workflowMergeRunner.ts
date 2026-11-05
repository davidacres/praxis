import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PRAXIS_METADATA_EXCLUDES,
  assessChangeScope,
  captureEvidenceEntry,
  computeFindingFingerprint,
  createEvidenceBundle,
  evidenceBundleId,
  withEvidenceEntry,
  writeEvidenceBundle,
  type StageDispatchContext,
  type StageOutcome,
  type WorkflowEvidenceBundleKey,
  type WorkflowMergeNode
} from '@praxis/core';
import { findRunBranch, preserveUncommittedWork, repositoryRoot, runWorktreeKey } from './runWork';
import { getCurrentBranch } from './gitService';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? (err instanceof Error ? err.message : String(err)),
      exitCode: error.code ?? 1
    };
  }
}

export async function runWorkflowMerge(
  node: WorkflowMergeNode,
  context: StageDispatchContext,
  projectFolder: string | undefined,
  evidenceRoot: string,
  resolveConflicts?: MergeConflictResolver
): Promise<StageOutcome> {
  const root = projectFolder ? await repositoryRoot(projectFolder) : undefined;
  if (!root) {
    return { status: 'failed', error: 'No Git repository found for this project.' };
  }

  // 1. If the worktree has any uncommitted changes, preserve them as a commit first
  if (context.worktreePath) {
    await preserveUncommittedWork(context.worktreePath, 'WIP: preserve changes for merge');
  }

  // 2. Identify the branch to merge
  const sourceBranch = context.run.sharedDeliveryBranch ?? (await findRunBranch(root, context.run.runId)) ?? runWorktreeKey(context.run.runId);
  const targetBranch = node.targetBranch?.trim() || (await getCurrentBranch(root)) || 'main';

  // 3. Execution log collector
  let log = `Initiating merge of branch ${sourceBranch} into ${targetBranch}...\n`;

  // Check if source branch exists
  const checkBranch = await git(root, ['rev-parse', '--verify', sourceBranch]);
  if (checkBranch.exitCode !== 0) {
    log += `Source branch ${sourceBranch} was not found in the repository.\n`;
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return { status: 'failed', error: `Source branch ${sourceBranch} was not found.` };
  }

  // Changes outside what the run declared are held back or flagged before anything merges.
  const scope = await checkDeclaredScope(node, root, sourceBranch, targetBranch);
  if (scope) log += `${scope.message}\n`;
  if (scope?.action === 'block') {
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return { status: 'failed', error: scope.message, findings: scope.findings };
  }

  // Check status of target repo
  // Praxis's own metadata (a workflow file, the project brief) is not work the merge could lose,
  // the same rule the start-of-run clean check uses.
  const statusCheck = await git(root, ['status', '--porcelain', '--', '.', ...PRAXIS_METADATA_EXCLUDES]);
  if (statusCheck.stdout.trim().length > 0) {
    log += `Target checkout has uncommitted changes:\n${statusCheck.stdout}\nCannot safely merge into dirty checkout.\n`;
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return {
      status: 'failed',
      error: 'Target checkout contains uncommitted changes. Please commit or stash them before merging.'
    };
  }

  // Checkout target branch if not already on it
  const current = (await getCurrentBranch(root)) || '';
  if (current !== targetBranch) {
    log += `Switching checkout to ${targetBranch}...\n`;
    const co = await git(root, ['checkout', targetBranch]);
    log += co.stdout + co.stderr;
    if (co.exitCode !== 0) {
      log += `Failed to checkout target branch ${targetBranch}.\n`;
      await writeMergeEvidence(context, node, evidenceRoot, log);
      return { status: 'failed', error: `Could not switch to target branch ${targetBranch}.` };
    }
  }

  // Run the merge command
  const mergeArgs = ['merge'];
  if (node.noFastForward !== false) {
    mergeArgs.push('--no-ff');
  }
  mergeArgs.push('-m', `Merge delivery run ${context.run.runId.slice(0, 8)}: ${context.run.definition.name}`);
  mergeArgs.push(sourceBranch);

  log += `$ git ${mergeArgs.join(' ')}\n`;
  const mergeResult = await git(root, mergeArgs);
  log += mergeResult.stdout;
  if (mergeResult.stderr) {
    log += mergeResult.stderr;
  }

  if (mergeResult.exitCode === 0) {
    log += `\nMerge succeeded cleanly into ${targetBranch}.\n`;
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return {
      status: 'succeeded',
      exitCode: 0,
      ...(scope ? { findings: scope.findings } : {})
    };
  }

  // Conflict occurred. The base checkout is never left half-merged, whatever happens next.
  log += `\nMerge conflict encountered!\n`;
  const conflictedFiles = await unmergedFiles(root);
  if (conflictedFiles.length > 0) {
    log += `Conflicted files:\n${conflictedFiles.map(f => ` - ${f}`).join('\n')}\n`;
  }
  log += `Aborting merge...\n`;
  await git(root, ['merge', '--abort']);
  log += `Merge aborted cleanly.\n`;

  // A person decides: a conflict stops the merge and asks, unless the workflow said to let AI
  // resolve every time, or the person chose "Let AI resolve" for this attempt.
  const attempt = context.run.nodes[node.id]?.attempts.length ?? 0;
  const useAi = node.onConflict === 'ai-resolve' || (attempt > 0 && context.run.mergeAiAttempt?.[node.id] === attempt);
  if (useAi) {
    if (!resolveConflicts || !context.worktreePath) {
      log += `AI resolution needs the run's worktree and an implementer stage; neither is available here.\n`;
      await writeMergeEvidence(context, node, evidenceRoot, log);
      return {
        status: 'failed',
        exitCode: mergeResult.exitCode,
        error: `Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}. AI resolution could not start: the run has no worktree.`
      };
    }

    // Resolve where the run's own work lives: bring the target into the run's branch, have the
    // implementer settle the conflicts there, and only then merge into the target again.
    const resolved = await resolveOnRunBranch(context.worktreePath, targetBranch, resolveConflicts);
    log += resolved.log;
    if (!resolved.ok) {
      await writeMergeEvidence(context, node, evidenceRoot, log);
      return {
        status: 'failed',
        exitCode: mergeResult.exitCode,
        error: `Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}. AI resolution did not settle it: ${resolved.error}`,
        conflictFiles: conflictedFiles
      };
    }

    log += `\n$ git ${mergeArgs.join(' ')}\n`;
    const retry = await git(root, mergeArgs);
    log += retry.stdout + retry.stderr;
    if (retry.exitCode === 0) {
      log += `\nMerge succeeded into ${targetBranch} after AI resolution.\n`;
      await writeMergeEvidence(context, node, evidenceRoot, log);
      return { status: 'succeeded', exitCode: 0, ...(scope ? { findings: scope.findings } : {}) };
    }
    const still = await unmergedFiles(root);
    await git(root, ['merge', '--abort']);
    log += `The merge still conflicts after AI resolution; aborted again.\n`;
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return {
      status: 'failed',
      exitCode: retry.exitCode,
      error: `The merge still conflicts after AI resolution, in ${still.length} file(s): ${still.join(', ')}.`
    };
  }

  await writeMergeEvidence(context, node, evidenceRoot, log);
  return {
    status: 'failed',
    exitCode: mergeResult.exitCode,
    error: `Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}. Nothing was merged. Choose "Let AI resolve the conflicts" on the run, or resolve them yourself and retry.`,
    conflictFiles: conflictedFiles
  };
}

/** Asks an agent to resolve conflict markers in the given files, in the given worktree. */
export type MergeConflictResolver = (request: { worktreePath: string; files: string[]; targetBranch: string }) => Promise<{ ok: boolean; error?: string }>;

async function unmergedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

/**
 * Merges `targetBranch` into the run's branch in its worktree and has the resolver settle any
 * conflict. Accepted only when the merge is concluded and no file it touched still carries a
 * conflict marker; otherwise the branch is put back exactly where it was.
 */
async function resolveOnRunBranch(
  worktreePath: string,
  targetBranch: string,
  resolver: MergeConflictResolver
): Promise<{ ok: boolean; error?: string; log: string }> {
  let log = `\nResolving on the run's branch in ${worktreePath}.\n`;
  const before = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
  const putBack = async (why: string) => {
    await git(worktreePath, ['merge', '--abort']);
    await git(worktreePath, ['reset', '--hard', before]);
    log += `${why} The run's branch was put back at ${before.slice(0, 8)}.\n`;
    return { ok: false, error: why, log };
  };

  const args = ['merge', '--no-ff', '-m', `Merge ${targetBranch} into the run branch to resolve conflicts`, targetBranch];
  log += `$ git ${args.join(' ')}\n`;
  const merged = await git(worktreePath, args);
  log += merged.stdout + merged.stderr;
  if (merged.exitCode === 0) return { ok: true, log: `${log}It merged cleanly on the run's branch.\n` };

  const files = await unmergedFiles(worktreePath);
  if (files.length === 0) return putBack(`Merging ${targetBranch} into the run's branch failed without a conflict to resolve.`);

  log += `Asking the implementer to resolve ${files.length} file(s): ${files.join(', ')}\n`;
  const outcome = await resolver({ worktreePath, files, targetBranch }).catch(error => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  if (!outcome.ok) return putBack(`The implementer could not resolve the conflicts: ${outcome.error ?? 'no reason given'}.`);

  // The agent stage commits what it leaves; an unfinished merge is concluded here. Either way
  // the result is accepted only if no file that conflicted still carries a marker.
  if ((await unmergedFiles(worktreePath)).length > 0) return putBack('Conflicts were left unresolved.');
  const mergeHead = await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.exitCode === 0) {
    await git(worktreePath, ['add', '-A']);
    const commit = await git(worktreePath, ['commit', '--no-edit']);
    log += commit.stdout + commit.stderr;
    if (commit.exitCode !== 0) return putBack('The resolved merge could not be committed.');
  }
  if ((await git(worktreePath, ['status', '--porcelain'])).stdout.trim()) {
    await git(worktreePath, ['add', '-A']);
    await git(worktreePath, ['commit', '-m', 'Resolve merge conflicts']);
  }
  const marked: string[] = [];
  for (const file of files) {
    const shown = await git(worktreePath, ['show', `HEAD:${file}`]);
    if (shown.exitCode === 0 && CONFLICT_MARKER.test(shown.stdout)) marked.push(file);
  }
  if (marked.length > 0) return putBack(`Conflict markers were left in ${marked.join(', ')}.`);
  const target = (await git(worktreePath, ['rev-parse', targetBranch])).stdout.trim();
  if ((await git(worktreePath, ['merge-base', '--is-ancestor', target, 'HEAD'])).exitCode !== 0) {
    return putBack(`The run's branch does not contain ${targetBranch} after resolution.`);
  }
  log += `Resolved on the run's branch.\n`;
  return { ok: true, log };
}

/**
 * FX-BE-094 / TASK-265: the paths the source branch changed, judged against the merge
 * node's declared paths. `undefined` when nothing is declared or everything is in scope.
 */
async function checkDeclaredScope(node: WorkflowMergeNode, root: string, sourceBranch: string, targetBranch: string) {
  if (!node.declaredPaths?.length) return undefined;
  const diff = await git(root, ['diff', '--name-only', `${targetBranch}...${sourceBranch}`]);
  if (diff.exitCode !== 0) return undefined;
  const changed = diff.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const assessment = assessChangeScope(
    changed,
    node.declaredPaths.map(declared => ({ kind: 'directory' as const, worktree: root, path: declared })),
    root,
    node.outOfScope ?? 'escalate'
  );
  if (assessment.action === 'none' || !assessment.message) return undefined;
  const severity = assessment.action === 'block' ? ('high' as const) : ('medium' as const);
  const message = assessment.message;
  return {
    action: assessment.action,
    message,
    findings: {
      findings: assessment.outOfScope.map(file => {
        const finding = { ruleId: 'out-of-scope-change', file, severity, category: 'scope', message: `${file} changed but is outside the paths this run declared.` };
        return { ...finding, fingerprint: computeFindingFingerprint(finding) };
      }),
      metrics: { outOfScope: assessment.outOfScope.length, inScope: assessment.inScope.length }
    }
  };
}

async function writeMergeEvidence(
  context: StageDispatchContext,
  node: WorkflowMergeNode,
  evidenceRoot: string,
  logContent: string
): Promise<void> {
  try {
    const key: WorkflowEvidenceBundleKey = {
      projectId: context.run.projectId,
      runId: context.run.runId,
      nodeId: node.id,
      attempt: Math.max(1, context.run.nodes[node.id]?.attempts.length ?? 1)
    };
    const { entry } = captureEvidenceEntry({
      bundleId: evidenceBundleId(key),
      kind: 'log',
      label: 'combined',
      capturedAt: new Date().toISOString(),
      content: logContent
    });
    const bundle = withEvidenceEntry(
      createEvidenceBundle({
        key,
        source: { kind: 'unknown' },
        createdAt: new Date().toISOString()
      }),
      entry
    );
    await writeEvidenceBundle(evidenceRoot, bundle, new Map([[entry.label, logContent]]));
  } catch (err) {
    console.error('[workflow] failed to write merge evidence bundle:', err);
  }
}
