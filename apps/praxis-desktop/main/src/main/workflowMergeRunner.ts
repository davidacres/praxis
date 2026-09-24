import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  captureEvidenceEntry,
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
  evidenceRoot: string
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
  const sourceBranch = (await findRunBranch(root, context.run.runId)) ?? runWorktreeKey(context.run.runId);
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

  // Check status of target repo
  const statusCheck = await git(root, ['status', '--porcelain']);
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
      exitCode: 0
    };
  }

  // Conflict occurred!
  log += `\nMerge conflict encountered!\n`;
  const conflictStatus = await git(root, ['status', '--porcelain']);
  const conflictedFiles = conflictStatus.stdout
    .split('\n')
    .filter(l => l.startsWith('UU ') || l.startsWith('AA ') || l.startsWith('UD ') || l.startsWith('DU '))
    .map(l => l.slice(3).trim());

  if (conflictedFiles.length > 0) {
    log += `Conflicted files:\n${conflictedFiles.map(f => ` - ${f}`).join('\n')}\n`;
  }

  if (node.onConflict === 'ai-resolve') {
    log += `onConflict is set to ai-resolve. Leaving conflict markers in place for agent resolution.\n`;
    await writeMergeEvidence(context, node, evidenceRoot, log);
    return {
      status: 'failed',
      exitCode: mergeResult.exitCode,
      error: `Merge conflict in ${conflictedFiles.length} files (${conflictedFiles.slice(0, 3).join(', ')}). Ready for AI resolution.`,
      pause: 'environment'
    };
  }

  // Default / 'fail': Abort the merge so the repo isn't left in a conflicted state
  log += `Aborting merge...\n`;
  await git(root, ['merge', '--abort']);
  log += `Merge aborted cleanly.\n`;
  await writeMergeEvidence(context, node, evidenceRoot, log);

  return {
    status: 'failed',
    exitCode: mergeResult.exitCode,
    error: `Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')}.`
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
