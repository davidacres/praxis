import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { changedPaths, commitPraxisWrite } from './ticketWriteBackCommit';

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
