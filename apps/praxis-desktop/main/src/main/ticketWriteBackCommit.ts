import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A concurrent Git reader may briefly hold the index; never remove its lock. */
export async function withGitIndexLockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const failure = error as { stderr?: unknown; code?: unknown } | null;
      const detail = String(failure?.stderr ?? error);
      if (attempt >= 5 || failure?.code !== 128 || !/fatal: Unable to create [^\r\n]*index\.lock['"]?: File exists/i.test(detail)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await withGitIndexLockRetry(() => execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))).stdout;
}

/** Paths with uncommitted changes, relative to the repository root. */
export async function changedPaths(root: string): Promise<Set<string>> {
  const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const paths = new Set<string>();
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    paths.add(record.slice(3));
    // A rename or copy carries its source path as the next record.
    if (record[0] === 'R' || record[0] === 'C') i++;
  }
  return paths;
}

/**
 * Commits exactly the files a Praxis write (a run outcome recorded on a ticket file) changed,
 * so Praxis's own bookkeeping does not leave the checkout dirty and stop the next scheduled
 * ticket from starting.
 *
 * Only files that had no uncommitted changes before the write are committed: one that was
 * already changed may hold the person's own edits, and those are never committed for them.
 * A file is only taken as Praxis's if it now contains `marker` (the text Praxis wrote), so
 * something else changing a file at the same moment is not swept in. Nothing is committed while
 * a merge or rebase is in progress. Returns the committed paths.
 */
export async function commitPraxisWrite(root: string, before: Set<string>, marker: string, message: string): Promise<string[]> {
  const after = await changedPaths(root);
  const candidates = [...after].filter(path => !before.has(path)).sort();
  const written: string[] = [];
  for (const path of candidates) {
    const text = await readFile(join(root, path), 'utf8').catch(() => '');
    if (text.includes(marker)) written.push(path);
  }
  if (written.length === 0) return [];
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
    const inProgress = await git(root, ['rev-parse', '-q', '--verify', marker]).then(() => true, () => false);
    if (inProgress) return [];
  }
  await git(root, ['add', '--', ...written]);
  // `--only` (implied by the paths) leaves anything else the person has staged untouched.
  await git(root, ['commit', '-m', message, '--', ...written]);
  return written;
}
