import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupRemovedWorktreeIndexes } from './codeIntelligenceCleanup';
import type { CodeIntelligenceResponse } from '@praxis/core';

test('startup cleanup removes only confirmed obsolete worktree indexes', async t => {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'praxis-index-cleanup-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const worktree = (name: string) => path.join(root, '.worktrees', name);
  const add = (name: string) => git('worktree', 'add', '-b', name, worktree(name));
  add('live');
  add('removed');
  git('worktree', 'remove', worktree('removed'));
  git('branch', '-d', 'removed');
  add('kept-branch');
  git('worktree', 'remove', worktree('kept-branch'));
  add('unavailable');
  // A missing directory with a surviving Git registration and branch is retained.
  rmSync(worktree('unavailable'), { recursive: true, force: true });
  add('deleted-branch');
  rmSync(worktree('deleted-branch'), { recursive: true, force: true });
  git('update-ref', '-d', 'refs/heads/deleted-branch');
  const ordinary = path.join(temporary, 'missing-project');
  const offline = path.join(temporary, 'offline', '.worktrees', 'missing');
  // A nested folder named .worktrees is not enough: its parent must be the Git root.
  const nested = path.join(root, 'nested');
  mkdirSync(nested);
  const roots = [root, worktree('live'), worktree('removed'), worktree('kept-branch'), worktree('unavailable'), worktree('deleted-branch'), ordinary, offline, path.join(nested, '.worktrees', 'missing')];
  const calls: string[][] = [];
  const warnings: unknown[] = [];
  const removed = await cleanupRemovedWorktreeIndexes(async args => {
    calls.push(args);
    return { data: args[0] === 'list' ? roots.map((root, id) => ({ root, id: String(id) })) : {} };
  }, (_message, error) => warnings.push(error));
  assert.deepEqual(removed, ['2', '3', '5']);
  assert.deepEqual(calls, [['list'], ['unregister', '2'], ['unregister', '3'], ['unregister', '5']]);
  assert.equal(warnings.length, 1, 'unreachable parent is reported and retained');
});

test('list failures never trigger unregister', async () => {
  for (const response of [{ error: { code: 'OFFLINE', message: 'offline' } }, { data: {} }]) {
    const calls: string[][] = [];
    await assert.rejects(cleanupRemovedWorktreeIndexes(async args => {
      calls.push(args);
      return response as CodeIntelligenceResponse;
    }, () => {}));
    assert.deepEqual(calls, [['list']]);
  }
});

test('unregister failures are reported and do not prevent other cleanup', async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'praxis-index-cleanup-error-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  const warnings: unknown[] = [];
  const removed = await cleanupRemovedWorktreeIndexes(async args => {
    if (args[0] === 'list') return { data: ['failed', 'ok'].map(id => ({ id, root: path.join(root, '.worktrees', id) })) };
    if (args[1] === 'failed') return { error: { code: 'BUSY', message: 'busy' } };
    return { data: {} };
  }, (_message, error) => warnings.push(error));
  assert.deepEqual(removed, ['ok']);
  assert.equal(warnings.length, 1);
});
