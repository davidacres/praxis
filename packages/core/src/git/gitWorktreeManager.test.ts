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
