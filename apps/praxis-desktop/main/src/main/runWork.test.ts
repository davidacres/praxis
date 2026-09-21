import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deleteRunWork, findRunBranch, inspectRunWork, preserveUncommittedWork, repositoryRoot, runWorktreeKey } from './runWork';

const RUN_ID = '83ce6324-a9fe-4dbb-bd3d-de576d47e3b2';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** A repo on `main` with a run branch `WF-83CE6324-…` holding `commits` commits, checked out in its own worktree. */
function fixture(commits: number): { repo: string; worktree: string; branch: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-runwork-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  const branch = `${runWorktreeKey(RUN_ID)}-governed-delivery-fx-bf-036`;
  const worktree = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-b', branch, worktree, 'main');
  for (let i = 1; i <= commits; i += 1) {
    fs.writeFileSync(path.join(worktree, `file${i}.txt`), `change ${i}\n`);
    git(worktree, 'add', '.');
    git(worktree, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', `feat: change ${i}`);
  }
  return { repo, worktree, branch, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the run branch is found by its run prefix, and only that run\'s', async () => {
  const f = fixture(1);
  try {
    assert.equal(await findRunBranch(f.repo, RUN_ID), f.branch);
    assert.equal(await findRunBranch(f.repo, 'ffffffff-0000-0000-0000-000000000000'), undefined);
    assert.equal(await repositoryRoot(f.repo), fs.realpathSync(f.repo));
    assert.equal(await repositoryRoot(os.tmpdir()), undefined);
  } finally { f.cleanup(); }
});

test('inspection counts only commits that exist nowhere else, newest first', async () => {
  const f = fixture(3);
  try {
    const info = await inspectRunWork(f.repo, RUN_ID, f.worktree);
    assert.equal(info.branch, f.branch);
    assert.equal(info.commitCount, 3);
    assert.deepEqual(info.commits.map(commit => commit.subject), ['feat: change 3', 'feat: change 2', 'feat: change 1']);
    assert.equal(info.worktreePath, f.worktree);
    assert.equal(info.uncommittedFiles, 0);

    // Once the work is merged, deleting the branch loses nothing — and inspection says so.
    git(f.repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '--no-ff', '-m', 'merge', f.branch);
    assert.equal((await inspectRunWork(f.repo, RUN_ID)).commitCount, 0);
  } finally { f.cleanup(); }
});

test('inspection reports uncommitted files in a live worktree and nothing for one that is gone', async () => {
  const f = fixture(1);
  try {
    fs.writeFileSync(path.join(f.worktree, 'half-done.ts'), 'wip\n');
    fs.writeFileSync(path.join(f.worktree, 'file1.txt'), 'edited\n');
    assert.equal((await inspectRunWork(f.repo, RUN_ID, f.worktree)).uncommittedFiles, 2);
    const gone = await inspectRunWork(f.repo, RUN_ID, path.join(f.worktree, 'nope'));
    assert.equal(gone.worktreePath, undefined);
    assert.equal(gone.uncommittedFiles, 0);
  } finally { f.cleanup(); }
});

test('uncommitted work is kept as a commit on the run branch rather than thrown away', async () => {
  const f = fixture(1);
  try {
    fs.writeFileSync(path.join(f.worktree, 'half-done.ts'), 'wip\n');
    assert.equal(await preserveUncommittedWork(f.worktree, 'WIP: kept'), true);
    assert.equal(git(f.worktree, 'status', '--porcelain').trim(), '');
    assert.match(git(f.repo, 'log', '-1', '--format=%s', f.branch), /WIP: kept/);
    // Nothing to keep: no empty commit.
    assert.equal(await preserveUncommittedWork(f.worktree, 'again'), false);
    assert.equal(await preserveUncommittedWork(path.join(f.worktree, 'missing'), 'x'), false);
  } finally { f.cleanup(); }
});

test('deleting a run\'s work removes its worktree and branch — and nothing else', async () => {
  const f = fixture(2);
  try {
    git(f.repo, 'branch', 'feature/unrelated');
    const result = await deleteRunWork(f.repo, RUN_ID, f.worktree);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchDeleted, f.branch);
    assert.equal(fs.existsSync(f.worktree), false);
    const branches = git(f.repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
    assert.deepEqual(branches, ['feature/unrelated', 'main']);
    // Idempotent: nothing left to delete is not an error.
    assert.deepEqual(await deleteRunWork(f.repo, RUN_ID, f.worktree), { worktreeRemoved: false });
  } finally { f.cleanup(); }
});

test('a branch that is checked out in the main working tree is never deleted', async () => {
  const f = fixture(1);
  try {
    git(f.repo, 'worktree', 'remove', '--force', f.worktree);
    git(f.repo, 'checkout', f.branch);
    await assert.rejects(deleteRunWork(f.repo, RUN_ID), /checked out in the main working tree/);
    assert.equal(await findRunBranch(f.repo, RUN_ID), f.branch);
  } finally { f.cleanup(); }
});
