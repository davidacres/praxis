import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { changedPaths, commitPraxisWrite, withGitIndexLockRetry } from './ticketWriteBackCommit';

test('a transient Git index lock retries only the rejected command', async () => {
  let calls = 0;
  const result = await withGitIndexLockRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error('Git refused the index'), { code: 128, stderr: "fatal: Unable to create '/fixture/.git/index.lock': File exists." });
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(calls, 3);
});

test('Git index lock retries are bounded and other failures are never retried', async () => {
  const locked = "fatal: Unable to create '/fixture/.git/index.lock': File exists.";
  for (const [message, code, expectedCalls] of [[locked, 128, 6], [locked, 1, 1], [locked, undefined, 1], ['permission denied', 128, 1]] as const) {
    const error = Object.assign(new Error(message), { code });
    let calls = 0;
    await assert.rejects(withGitIndexLockRetry(async () => {
      if (++calls > expectedCalls) throw new Error('Exceeded the expected retry budget');
      throw error;
    }), reason => reason === error);
    assert.equal(calls, expectedCalls);
  }
});

test('an occupied index lock is preserved and a failed write-back never reports a commit', async () => {
  const { root, git, cleanup } = repo();
  try {
    const before = await changedPaths(root);
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), `\n${COMMENT}\n`);
    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, 'held by another Git process', { flag: 'wx' });
    await assert.rejects(commitPraxisWrite(root, before, COMMENT, 'Record outcome'), /index\.lock/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'held by another Git process');
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
    fs.unlinkSync(lock); // Only this test's own sentinel, after verifying production left it intact.
    assert.deepEqual(await commitPraxisWrite(root, before, COMMENT, 'Record outcome'), ['plans/task-1.md']);
    assert.equal(git('status', '--porcelain').trim(), '');
  } finally {
    cleanup();
  }
});

function repo(): { root: string; git: (...args: string[]) => string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-writeback-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Praxis Test');
  git('config', 'user.email', 'test@praxis.local');
  fs.mkdirSync(path.join(root, 'plans'));
  fs.writeFileSync(path.join(root, 'plans', 'task-1.md'), '# TASK-1\n\n## Comments\n');
  fs.writeFileSync(path.join(root, 'plans', 'task-2.md'), '# TASK-2\n\n## Comments\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'mine\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  return { root, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const COMMENT = '**Workflow run succeeded: Governed delivery — TASK-1**';

test('a recorded run outcome is committed on its own, so the checkout stays clean', async () => {
  const { root, git, cleanup } = repo();
  try {
    const before = await changedPaths(root);
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), `\n${COMMENT}\n`);
    const committed = await commitPraxisWrite(root, before, COMMENT, 'Record run outcome on TASK-1');
    assert.deepEqual(committed, ['plans/task-1.md']);
    assert.equal(git('status', '--porcelain').trim(), '');
    assert.equal(git('log', '-1', '--format=%s').trim(), 'Record run outcome on TASK-1');
  } finally {
    cleanup();
  }
});

test("the person's own uncommitted work is never committed for them", async () => {
  const { root, git, cleanup } = repo();
  try {
    // Already edited by the person before Praxis wrote to it, plus unrelated work elsewhere.
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), '\nmy own note\n');
    fs.appendFileSync(path.join(root, 'notes.md'), 'more of mine\n');
    git('add', 'notes.md');
    const before = await changedPaths(root);
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), `\n${COMMENT}\n`);
    // Changed at the same moment by something else, without Praxis's text.
    fs.appendFileSync(path.join(root, 'plans', 'task-2.md'), '\nsomeone else\n');

    const committed = await commitPraxisWrite(root, before, COMMENT, 'Record run outcome on TASK-1');
    assert.deepEqual(committed, []);
    assert.equal(git('log', '--format=%s').trim().split('\n').length, 1, 'nothing committed');
    // Staged work stays staged.
    assert.match(git('status', '--porcelain'), /^M  notes\.md$/m);
  } finally {
    cleanup();
  }
});

test('staged work elsewhere stays staged and out of the commit', async () => {
  const { root, git, cleanup } = repo();
  try {
    fs.appendFileSync(path.join(root, 'notes.md'), 'staged by me\n');
    git('add', 'notes.md');
    const before = await changedPaths(root);
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), `\n${COMMENT}\n`);
    assert.deepEqual(await commitPraxisWrite(root, before, COMMENT, 'Record run outcome on TASK-1'), ['plans/task-1.md']);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['plans/task-1.md']);
    assert.match(git('status', '--porcelain'), /^M  notes\.md$/m);
  } finally {
    cleanup();
  }
});

test('nothing is committed in the middle of a merge', async () => {
  const { root, git, cleanup } = repo();
  try {
    git('checkout', '-b', 'side');
    fs.writeFileSync(path.join(root, 'notes.md'), 'side\n');
    git('commit', '-am', 'side');
    git('checkout', 'main');
    fs.writeFileSync(path.join(root, 'notes.md'), 'main\n');
    git('commit', '-am', 'main');
    try { git('merge', 'side'); } catch { /* conflicts, as intended */ }
    const before = await changedPaths(root);
    fs.appendFileSync(path.join(root, 'plans', 'task-1.md'), `\n${COMMENT}\n`);
    assert.deepEqual(await commitPraxisWrite(root, before, COMMENT, 'Record run outcome on TASK-1'), []);
  } finally {
    cleanup();
  }
});
