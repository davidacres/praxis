import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import { getGitStatus, loadGitRepository } from './gitService';

const execFile = util.promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

test('handles missing Git, non-repositories, worktrees, shallow history, and detached HEAD', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ticket-manager-git-'));
  const repository = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const shallow = path.join(root, 'shallow');
  const originalGitPath = process.env.TICKET_MANAGER_GIT_PATH;
  try {
    await fsp.mkdir(repository);
    process.env.TICKET_MANAGER_GIT_PATH = path.join(root, 'missing-git');
    await assert.rejects(() => loadGitRepository(repository), /Git could not complete/);
    delete process.env.TICKET_MANAGER_GIT_PATH;
    await assert.rejects(() => loadGitRepository(root), /Git could not complete/);

    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.name', 'Fixture User');
    await git(repository, 'config', 'user.email', 'fixture@example.test');
    await fsp.writeFile(path.join(repository, 'README.md'), 'base\n');
    await git(repository, 'add', 'README.md');
    await git(repository, 'commit', '-m', 'base');
    await git(repository, 'tag', 'v1.0');
    await git(repository, 'branch', 'feature/topic');
    await fsp.writeFile(path.join(repository, 'README.md'), 'feature\n');
    await git(repository, 'add', 'README.md');
    await git(repository, 'commit', '-m', 'feature');

    const snapshot = await loadGitRepository(repository, { force: true });
    assert.equal(snapshot.currentBranch, 'main');
    assert.ok(snapshot.tags.includes('v1.0'));
    assert.ok(snapshot.branches.some(branch => branch.name === 'feature/topic'));
    assert.ok((await getGitStatus(repository)).repositoryPath.endsWith('/repo'));

    await git(repository, 'worktree', 'add', worktree, 'feature/topic');
    const worktreeSnapshot = await loadGitRepository(worktree, { force: true });
    assert.equal(worktreeSnapshot.currentBranch, 'feature/topic');

    await git(repository, 'clone', '--depth=1', `file://${repository}`, shallow);
    const shallowSnapshot = await loadGitRepository(shallow, { force: true });
    assert.equal(shallowSnapshot.commits.length, 1);

    await git(repository, 'checkout', '--detach', 'HEAD');
    const detachedSnapshot = await loadGitRepository(repository, { force: true });
    assert.equal(detachedSnapshot.currentBranch, undefined);
  } finally {
    if (originalGitPath === undefined) delete process.env.TICKET_MANAGER_GIT_PATH;
    else process.env.TICKET_MANAGER_GIT_PATH = originalGitPath;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
