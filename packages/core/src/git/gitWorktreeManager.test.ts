import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import {
  GitWorktreeManager,
  WorktreeConflictError,
  resolveRepoWorktreeRoot
} from './gitWorktreeManager';

const execFile = util.promisify(execFileCallback);
const silentLogger = { appendLine: () => {} };

test('resolveRepoWorktreeRoot stores worktrees under the repository', () => {
  const repoRoot = path.join(path.parse(path.resolve('.')).root, 'dev', 'praxis');
  assert.equal(resolveRepoWorktreeRoot(repoRoot), path.join(repoRoot, '.worktrees'));
});

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-worktree-'));
  const git = (args: string[]) => execFile('git', args, { cwd: dir, windowsHide: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(dir, 'README.md'), '# temp\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
  return dir;
}

test('prepareDeliveryWorktree creates a branch and checkout, then removeDeliveryWorktree tears them down', async t => {
  let repo: string;
  try {
    repo = await initRepo();
  } catch {
    t.skip('git not available');
    return;
  }
  try {
    const manager = new GitWorktreeManager(silentLogger);
    const issue = { key: 'SESSION-abcd1234', summary: 'add a folder picker', branch: undefined };
    const prepared = await manager.prepareDeliveryWorktree(issue, 'main', repo);

    assert.equal(prepared.baseBranch, 'main');
    assert.ok(prepared.worktreeName.startsWith('SESSION-abcd1234'));
    const stat = await fs.stat(prepared.worktreePath);
    assert.equal(stat.isDirectory(), true);

    await assert.rejects(
      () => manager.prepareDeliveryWorktree(issue, 'main', repo),
      WorktreeConflictError
    );

    await manager.removeDeliveryWorktree(repo, {
      worktreePath: prepared.worktreePath,
      branchName: prepared.branchName
    });
    await assert.rejects(() => fs.stat(prepared.worktreePath));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('prepareDeliveryWorktree refuses to omit a dirty base when a governed run requires a clean snapshot', async t => {
  let repo: string;
  try {
    repo = await initRepo();
  } catch {
    t.skip('git not available');
    return;
  }
  try {
    await fs.writeFile(path.join(repo, 'README.md'), '# uncommitted change\n', 'utf8');
    const manager = new GitWorktreeManager(silentLogger);

    await assert.rejects(
      () => manager.prepareDeliveryWorktree(
        { key: 'WF-DIRTY', summary: 'governed delivery', branch: undefined },
        'main',
        repo,
        { requireCleanBase: true }
      ),
      /Workflow worktrees branch from committed HEAD.*Commit or stash/s
    );

    const worktreeRoot = resolveRepoWorktreeRoot(repo);
    const entries = await fs.readdir(worktreeRoot).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('removeDeliveryWorktree with keepBranch removes the checkout but leaves the branch and its commits', async t => {
  let repo: string;
  try {
    repo = await initRepo();
  } catch {
    t.skip('git not available');
    return;
  }
  try {
    const manager = new GitWorktreeManager(silentLogger);
    const prepared = await manager.prepareDeliveryWorktree(
      { key: 'WF-83CE6324', summary: 'governed delivery', branch: undefined }, 'main', repo
    );
    const git = (cwd: string, args: string[]) => execFile('git', args, { cwd, windowsHide: true });
    await fs.writeFile(path.join(prepared.worktreePath, 'work.txt'), 'the run\'s work\n', 'utf8');
    await git(prepared.worktreePath, ['add', '.']);
    await git(prepared.worktreePath, ['commit', '-m', 'feat: the work']);

    // The branch name is `<key>-<slug>`, so a caller that only knows the key would not even match it —
    // and one that did match would take the commits with it. keepBranch makes "checkout only" explicit.
    await manager.removeDeliveryWorktree(
      repo,
      { worktreePath: prepared.worktreePath, branchName: prepared.branchName },
      { keepBranch: true }
    );
    await assert.rejects(() => fs.stat(prepared.worktreePath));
    const branches = (await git(repo, ['branch', '--format=%(refname:short)'])).stdout.split('\n').filter(Boolean);
    assert.ok(branches.includes(prepared.branchName), 'the branch survives');
    assert.match((await git(repo, ['log', '-1', '--format=%s', prepared.branchName])).stdout, /feat: the work/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
