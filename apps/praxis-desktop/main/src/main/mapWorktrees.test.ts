import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createItemWorktree, mapItemBranch, mergeItemBranch, releaseItemWorktree } from './mapWorktrees';
import { findRunBranch } from './runWork';

const RUN_ID = '5a1e2b3c-0000-4000-8000-000000000001';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', message);
}

test('three items in their own worktrees merge back in order; the conflicting one is backed out and named', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-map-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
    commitAll(repo, 'initial');
    const runWorktree = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-b', `WF-5A1E2B3C-fan`, runWorktree, 'main');

    const branches = [0, 1, 2].map(index => mapItemBranch(RUN_ID, 'fix', index));
    const paths = [];
    for (const branch of branches) paths.push(await createItemWorktree(runWorktree, branch));
    // Item 1 edits a.ts, item 2 edits b.ts, item 3 edits the same line of a.ts as item 1.
    fs.writeFileSync(path.join(paths[0], 'a.ts'), 'export const a = 2;\n');
    commitAll(paths[0], 'fix a');
    fs.writeFileSync(path.join(paths[1], 'b.ts'), 'export const b = 2;\n');
    commitAll(paths[1], 'fix b');
    fs.writeFileSync(path.join(paths[2], 'a.ts'), 'export const a = 3;\n');
    commitAll(paths[2], 'also fix a');
    // Something an item left uncommitted is kept on its branch, not lost.
    fs.writeFileSync(path.join(paths[1], 'notes.txt'), 'left behind\n');
    for (const itemPath of paths) await releaseItemWorktree(runWorktree, itemPath);
    assert.ok(paths.every(itemPath => !fs.existsSync(itemPath)), 'item worktrees are released');
    assert.match(git(runWorktree, 'log', '--format=%s', '-1', branches[1]), /WIP: changes left uncommitted by a map item/);

    assert.deepEqual(await mergeItemBranch(runWorktree, branches[0], 'A'), { ok: true });
    assert.deepEqual(await mergeItemBranch(runWorktree, branches[1], 'B'), { ok: true });
    const conflict = await mergeItemBranch(runWorktree, branches[2], 'A again');
    assert.equal(conflict.ok, false);
    assert.deepEqual(conflict.ok ? [] : conflict.conflicts, ['a.ts']);

    // Nothing half-merged: the run's tree is clean and holds items 1 and 2.
    assert.equal(git(runWorktree, 'status', '--porcelain').trim(), '');
    assert.equal(fs.readFileSync(path.join(runWorktree, 'a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.equal(fs.readFileSync(path.join(runWorktree, 'b.ts'), 'utf8'), 'export const b = 2;\n');
    // Item branches never shadow the run's own branch.
    assert.equal(await findRunBranch(repo, RUN_ID), 'WF-5A1E2B3C-fan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
