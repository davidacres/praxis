import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import { applyGitHunk, cloneGitRepository, discardGit, getGitBlame, getGitComparison, getGitConflict, getGitFileHistory, getGitStatus, initializeGitRepository, loadGitRepository, mergeGit, popGitStash, preflightGitRepository, resolveGitConflict, stashGit } from './gitService';

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
    assert.equal((await preflightGitRepository()).status, 'no-workspace');
    assert.equal((await preflightGitRepository(root)).status, 'not-a-repository');
    const initialized = await initializeGitRepository(root);
    assert.equal(initialized.status, 'repository');

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
    const cloneParent = path.join(root, 'clones');
    await fsp.mkdir(cloneParent);
    assert.equal((await cloneGitRepository(`file://${repository}`, cloneParent, 'clone')).status, 'repository');
    assert.ok((await getGitStatus(repository)).repositoryPath.endsWith('/repo'));
    assert.equal((await getGitFileHistory(repository, 'README.md'))[0].message, 'feature');
    assert.equal((await getGitBlame(repository, 'README.md'))[0].author, 'Fixture User');

    await fsp.writeFile(path.join(repository, 'README.md'), 'feature\nworking line\n');
    await fsp.writeFile(path.join(repository, 'notes.txt'), 'untracked note\n');
    const workingDiff = await getGitComparison(repository, { kind: 'working' });
    assert.equal(workingDiff.title, 'Working changes');
    assert.equal(workingDiff.files[0].displayPath, 'README.md');
    assert.equal(workingDiff.files[0].additions, 1);
    assert.equal(workingDiff.files.find(file => file.displayPath === 'notes.txt')?.status, 'added');
    const selectedHunk = workingDiff.files[0].hunks[0];
    const stagedStatus = await applyGitHunk(repository, { action: 'stage', path: 'README.md', patch: selectedHunk.patch });
    assert.equal(stagedStatus.files.find(file => file.path === 'README.md')?.staged, true);
    const stagedDiff = await getGitComparison(repository, { kind: 'staged' });
    assert.equal(stagedDiff.files[0].hunks.length, 1);
    await applyGitHunk(repository, { action: 'unstage', path: 'README.md', patch: stagedDiff.files[0].hunks[0].patch });
    assert.equal((await getGitStatus(repository)).files.find(file => file.path === 'README.md')?.staged, false);
    await discardGit(repository, ['README.md']);
    assert.equal((await getGitStatus(repository)).files.some(file => file.path === 'README.md'), false);
    await stashGit(repository, 'test untracked stash');
    assert.equal((await getGitStatus(repository)).files.length, 0);
    await popGitStash(repository);
    assert.equal((await getGitStatus(repository)).files.some(file => file.path === 'notes.txt'), true);

    const commitDiff = await getGitComparison(repository, { kind: 'commit', left: snapshot.head });
    assert.ok(commitDiff.files.some(file => file.displayPath === 'README.md'));

    await git(repository, 'worktree', 'add', worktree, 'feature/topic');
    const worktreeSnapshot = await loadGitRepository(worktree, { force: true });
    assert.equal(worktreeSnapshot.currentBranch, 'feature/topic');

    await git(repository, 'clone', '--depth=1', `file://${repository}`, shallow);
    const shallowSnapshot = await loadGitRepository(shallow, { force: true });
    assert.equal(shallowSnapshot.commits.length, 1);

    await git(repository, 'switch', '-c', 'conflict-side', 'HEAD~1');
    await fsp.writeFile(path.join(repository, 'README.md'), 'incoming version\n');
    await git(repository, 'add', 'README.md');
    await git(repository, 'commit', '-m', 'incoming conflict');
    await git(repository, 'switch', 'main');
    await fsp.writeFile(path.join(repository, 'README.md'), 'current version\n');
    await git(repository, 'add', 'README.md');
    await git(repository, 'commit', '-m', 'current conflict');
    await mergeGit(repository, 'conflict-side');
    const conflictStatus = await getGitStatus(repository);
    assert.equal(conflictStatus.files[0].conflicted, true);
    const conflict = await getGitConflict(repository, 'README.md');
    assert.match(conflict.current, /current version/);
    assert.match(conflict.incoming, /incoming version/);
    await assert.rejects(
      () => resolveGitConflict(repository, 'README.md', { strategy: 'manual', content: conflict.result }),
      /Remove every conflict marker/
    );
    assert.equal((await getGitStatus(repository)).files[0].conflicted, true);
    const resolvedStatus = await resolveGitConflict(repository, 'README.md', { strategy: 'current' });
    assert.equal(resolvedStatus.files.some(file => file.conflicted), false);
    await git(repository, 'commit', '-m', 'resolve conflict');

    await git(repository, 'checkout', '--detach', 'HEAD');
    const detachedSnapshot = await loadGitRepository(repository, { force: true });
    assert.equal(detachedSnapshot.currentBranch, undefined);
  } finally {
    if (originalGitPath === undefined) delete process.env.TICKET_MANAGER_GIT_PATH;
    else process.env.TICKET_MANAGER_GIT_PATH = originalGitPath;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('git operations refuse an empty repository path instead of guessing one', async () => {
  // Git is per-project. This used to fall back to a
  // TICKET_MANAGER_DEFAULT_REPOSITORY env var and then to `process.cwd()`,
  // which silently resolved against whatever directory the app was launched
  // from — so a Refresh with no path quietly swapped to an unrelated
  // repository. Refusing is the honest answer.
  const originalDefault = process.env.TICKET_MANAGER_DEFAULT_REPOSITORY;
  process.env.TICKET_MANAGER_DEFAULT_REPOSITORY = process.cwd();
  try {
    for (const empty of ['', '   ']) {
      await assert.rejects(
        () => loadGitRepository(empty),
        /No repository path was supplied/,
        `expected "${empty}" to be refused`
      );
    }
    // Even with the old env var set, it must not be consulted.
    await assert.rejects(
      () => loadGitRepository(undefined as unknown as string),
      /No repository path was supplied/
    );
  } finally {
    if (originalDefault === undefined) delete process.env.TICKET_MANAGER_DEFAULT_REPOSITORY;
    else process.env.TICKET_MANAGER_DEFAULT_REPOSITORY = originalDefault;
  }
});
