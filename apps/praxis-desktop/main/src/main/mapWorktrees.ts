import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { preserveUncommittedWork, runWorktreeKey } from './runWork';

/**
 * The git half of a map node's fan-out (FX-BE-165): a worktree and branch per writing
 * item, cut from the run's current commit, and a merge back that never leaves a
 * half-merged tree. Kept apart from the runner so it is testable without Electron.
 */

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export async function revParseHead(cwd: string): Promise<string | undefined> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim() || undefined;
}

/** An item's branch. Not under the run's `WF-<run8>` prefix, so it is never mistaken for the run's own branch. */
export function mapItemBranch(runId: string, nodeId: string, index: number): string {
  return `wfitem-${runWorktreeKey(runId).replace(/^WF-/, '').toLowerCase()}-${nodeId.replace(/[^A-Za-z0-9-]/g, '-')}-${index + 1}`;
}


export async function createItemWorktree(runWorktree: string, branch: string): Promise<string> {
  const itemPath = path.join(path.dirname(runWorktree), `${path.basename(runWorktree)}--${branch}`);
  await rm(itemPath, { recursive: true, force: true });
  // A branch left from an earlier attempt is replaced: the item starts again from the run's current commit.
  await git(runWorktree, ['worktree', 'prune']);
  await git(runWorktree, ['worktree', 'add', '-B', branch, itemPath, 'HEAD']);
  return itemPath;
}

export async function releaseItemWorktree(runWorktree: string, itemPath: string, log: (line: string) => void = () => undefined): Promise<void> {
  try {
    await preserveUncommittedWork(itemPath, 'WIP: changes left uncommitted by a map item');
    await git(runWorktree, ['worktree', 'remove', '--force', itemPath]);
  } catch (error) {
    log(`Could not release map item worktree ${itemPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Merges an item's branch into the run's tree. On a conflict the merge is backed out
 * and the files both sides changed are reported; nothing half-merged is left behind.
 */
export async function mergeItemBranch(runWorktree: string, branch: string, label: string): Promise<{ ok: true } | { ok: false; conflicts: string[]; detail: string }> {
  const ahead = (await git(runWorktree, ['rev-list', '--count', `HEAD..${branch}`])).trim();
  if (ahead === '0') return { ok: true };
  try {
    await git(runWorktree, [
      '-c', 'user.name=Praxis', '-c', 'user.email=praxis@localhost', '-c', 'commit.gpgsign=false',
      'merge', '--no-ff', '--no-edit', '-m', `Merge map item: ${label}`, branch
    ]);
    return { ok: true };
  } catch (error) {
    const conflicts = (await git(runWorktree, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    await git(runWorktree, ['merge', '--abort']).catch(() => undefined);
    return { ok: false, conflicts, detail: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}

