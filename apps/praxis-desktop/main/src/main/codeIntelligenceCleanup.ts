import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodeIntelligenceResponse } from '@praxis/core';

const execute = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 })).stdout;
}

async function missing(root: string): Promise<boolean> {
  try { await lstat(root); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** Only collect removed Praxis worktrees; an unavailable ordinary folder is not proof of deletion. */
async function removedWorktree(root: string): Promise<boolean> {
  if (!path.isAbsolute(root) || path.basename(path.dirname(root)) !== '.worktrees' || !await missing(root)) return false;
  const repository = path.dirname(path.dirname(root));
  const top = (await git(repository, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== await realpath(repository)) return false;
  const records = (await git(repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const record = records.map(value => value.split('\0')).find(fields => fields.includes(`worktree ${root}`));
  if (record) {
    // A checkout may be temporarily unavailable. Keep it while its Git registration
    // and branch still exist, including locked and detached worktrees.
    const branch = record.find(field => field.startsWith('branch refs/heads/'))?.slice('branch '.length);
    if (!branch) return false;
    try { await git(repository, ['show-ref', '--verify', '--quiet', branch]); return false; }
    catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  }
  // Recheck immediately before unregistering in case a checkout was recreated.
  return missing(root);
}

export async function cleanupRemovedWorktreeIndexes(
  invoke: (args: string[]) => Promise<CodeIntelligenceResponse>,
  warn: (message: string, error: unknown) => void
): Promise<string[]> {
  const listed = await invoke(['list']);
  if (listed.error) throw new Error(listed.error.message);
  if (!Array.isArray(listed.data)) throw new Error('Invalid code intelligence repository list.');
  const removed: string[] = [];
  for (const repository of listed.data as Array<{ id?: unknown; root?: unknown }>) {
    if (!repository || typeof repository.id !== 'string' || typeof repository.root !== 'string') continue;
    try {
      if (!await removedWorktree(repository.root)) continue;
      const result = await invoke(['unregister', repository.id]);
      if (result.error) throw new Error(result.error.message);
      removed.push(repository.id);
    } catch (error) { warn(`Could not clean up code intelligence index for ${repository.root}:`, error); }
  }
  return removed;
}
