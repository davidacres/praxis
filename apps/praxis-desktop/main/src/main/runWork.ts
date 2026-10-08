import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * What a governed run leaves in the repository: a `WF-<run8>-<slug>` branch (its commits) and,
 * while the run is live, a worktree checkout of it.
 *
 * This is the run's actual output — the plan is prose, the implement stage's edits are commits on
 * that branch. Deleting the *run record* must therefore never silently decide the fate of that
 * work, which is why this module answers "what would be lost" and only deletes on request.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Stable per-run key: `WF-` + the first 8 characters of the run id, upper-cased. */
export function runWorktreeKey(runId: string): string {
  return `WF-${runId.slice(0, 8).toUpperCase()}`;
}

export interface RunWorkInfo {
  /** The run's branch, when one exists in the repository. */
  branch?: string;
  /** Commits on that branch that exist on no other local or remote branch — what deleting it would lose. */
  commitCount: number;
  /** Newest first, at most five. */
  commits: Array<{ sha: string; subject: string }>;
  /** The run's live worktree checkout, when it still exists on disk. */
  worktreePath?: string;
  /** Files with uncommitted changes in that worktree. */
  uncommittedFiles: number;
}

/** The repository's top-level directory for any path inside it, or undefined when it is not a repository. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
  try {
    return (await git(folder, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The branch created for this run, found by its deterministic `WF-<run8>` prefix. */
export async function findRunBranch(repoRoot: string, runId: string): Promise<string | undefined> {
  const key = runWorktreeKey(runId);
  try {
    const out = await git(repoRoot, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${key}`, `refs/heads/${key}-*`]);
    return out.split('\n').map(line => line.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/**
 * Args that select "commits reachable from `branch` but from no other branch, local or remote".
 * Note `--exclude` is given the bare branch name here: applied to `--branches`, git matches it with
 * the `refs/heads/` prefix already stripped, and a `refs/heads/…` pattern silently excludes nothing —
 * which counts the branch against itself and reports 0 commits at risk.
 */
function onlyOnBranch(branch: string): string[] {
  return [branch, '--not', `--exclude=${branch}`, '--branches', '--remotes'];
}

/** Describes the work a run would leave behind if its record were deleted now. */
export async function inspectRunWork(repoRoot: string, runId: string, worktreePath?: string): Promise<RunWorkInfo> {
  const branch = await findRunBranch(repoRoot, runId);
  const info: RunWorkInfo = { commitCount: 0, commits: [], uncommittedFiles: 0 };

  if (branch) {
    info.branch = branch;
    try {
      info.commitCount = Number.parseInt((await git(repoRoot, ['rev-list', '--count', ...onlyOnBranch(branch)])).trim(), 10) || 0;
      info.commits = (await git(repoRoot, ['log', '--format=%h%x09%s', '--max-count=5', ...onlyOnBranch(branch)]))
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [sha, ...rest] = line.split('\t');
          return { sha, subject: rest.join('\t') };
        });
    } catch {
      /* an unreadable branch is reported as having no countable commits, not as an error */
    }
  }

  if (worktreePath && (await exists(worktreePath))) {
    info.worktreePath = worktreePath;
    try {
      info.uncommittedFiles = (await git(worktreePath, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
    } catch {
      /* the checkout is not a usable worktree any more */
    }
  }
  return info;
}

/**
 * Commits whatever a worktree has uncommitted, so removing the checkout cannot throw it away.
 * Returns whether anything was committed. Throws if there was something to keep and it could not
 * be kept — the caller must then leave the worktree in place rather than remove it.
 */
export async function preserveUncommittedWork(worktreePath: string, message: string): Promise<boolean> {
  if (!(await exists(worktreePath))) return false;
  const status = (await git(worktreePath, ['status', '--porcelain'])).trim();
  if (!status) return false;
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, [
    '-c', 'user.name=Praxis',
    '-c', 'user.email=praxis@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', message
  ]);
  return true;
}

/**
 * Puts a run's worktree back to an earlier commit's content as a **new** commit on top
 * (keep-best loops, FX-BE-166). Nothing is rewritten: the iteration being undone stays in the
 * branch's history, inspectable, and anything left uncommitted is kept as its own commit first.
 *
 * Returns whether a restore commit was made (false when the tree already matched `ref`).
 */
export async function restoreWorktreeTo(worktreePath: string, ref: string, message: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) throw new Error(`Refusing to restore to "${ref}": not a commit id.`);
  await preserveUncommittedWork(worktreePath, 'WIP: changes left uncommitted before restoring the best iteration');
  await git(worktreePath, ['cat-file', '-e', `${ref}^{commit}`]);
  // `--staged --worktree` also removes files the restored commit did not have.
  await git(worktreePath, ['restore', `--source=${ref}`, '--staged', '--worktree', '--', ':/']);
  const status = (await git(worktreePath, ['status', '--porcelain'])).trim();
  if (!status) return false;
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, [
    '-c', 'user.name=Praxis',
    '-c', 'user.email=praxis@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', message
  ]);
  return true;
}

export interface DeleteRunWorkResult {
  branchDeleted?: string;
  worktreeRemoved: boolean;
}

/**
 * Deletes the run's worktree and branch. Only ever the branch found by this run's own prefix, and
 * never one that is checked out in the main working tree.
 */
export async function deleteRunWork(repoRoot: string, runId: string, worktreePath?: string): Promise<DeleteRunWorkResult> {
  const result: DeleteRunWorkResult = { worktreeRemoved: false };

  if (worktreePath && (await exists(worktreePath))) {
    try {
      await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await git(repoRoot, ['worktree', 'prune']).catch(() => undefined);
    }
    result.worktreeRemoved = true;
  }

  const branch = await findRunBranch(repoRoot, runId);
  if (!branch) return result;

  const current = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (current === branch) {
    throw new Error(`Branch ${branch} is checked out in the main working tree, so it was not deleted.`);
  }
  await git(repoRoot, ['branch', '-D', branch]);
  result.branchDeleted = branch;
  return result;
}
