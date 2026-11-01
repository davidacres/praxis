import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeEscapingDependencyLinks } from './worktreeDependencyLinks';

/** A main checkout with installed packages, and a run worktree beside it with none. */
function layout(): { main: string; worktree: string; cleanup: () => void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-deplinks-')));
  const main = path.join(base, 'main');
  const worktree = path.join(base, 'worktree');
  for (const root of [main, worktree]) {
    fs.mkdirSync(path.join(root, 'packages', 'p'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
    fs.writeFileSync(path.join(root, 'packages', 'p', 'package.json'), '{"name":"p"}');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
  }
  fs.mkdirSync(path.join(main, 'packages', 'p', 'node_modules', '@noble', 'curves'), { recursive: true });
  fs.writeFileSync(path.join(main, 'packages', 'p', 'node_modules', '@noble', 'curves', 'index.js'), 'main checkout package');
  fs.mkdirSync(path.join(main, 'node_modules', 'left-pad'), { recursive: true });
  return { main, worktree, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("a worktree package's node_modules linked to the main checkout is unlinked, and the main checkout keeps its packages", async () => {
  const { main, worktree, cleanup } = layout();
  try {
    fs.symlinkSync(path.join(main, 'packages', 'p', 'node_modules'), path.join(worktree, 'packages', 'p', 'node_modules'));
    const removed = await removeEscapingDependencyLinks(worktree);
    assert.deepEqual(removed.map(entry => entry.link), ['packages/p/node_modules']);
    assert.equal(fs.existsSync(path.join(worktree, 'packages', 'p', 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(main, 'packages', 'p', 'node_modules', '@noble', 'curves', 'index.js'), 'utf8'), 'main checkout package');
  } finally {
    cleanup();
  }
});

test('single package and scoped package links out of the worktree are removed; workspace links into it stay', async () => {
  const { main, worktree, cleanup } = layout();
  try {
    const modules = path.join(worktree, 'node_modules');
    fs.mkdirSync(path.join(modules, '@noble'), { recursive: true });
    fs.mkdirSync(path.join(modules, '@praxis'), { recursive: true });
    fs.symlinkSync(path.join(main, 'node_modules', 'left-pad'), path.join(modules, 'left-pad'));
    fs.symlinkSync(path.join(main, 'packages', 'p', 'node_modules', '@noble', 'curves'), path.join(modules, '@noble', 'curves'));
    fs.symlinkSync('../../packages/p', path.join(modules, '@praxis', 'p'));
    fs.symlinkSync(path.join(worktree, 'packages', 'p'), path.join(modules, 'p-absolute'));

    const removed = await removeEscapingDependencyLinks(worktree);
    assert.deepEqual(removed.map(entry => entry.link).sort(), ['node_modules/@noble/curves', 'node_modules/left-pad']);
    assert.ok(fs.lstatSync(path.join(modules, '@praxis', 'p')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(modules, 'p-absolute')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(main, 'node_modules', 'left-pad')));
  } finally {
    cleanup();
  }
});

test('a worktree whose whole node_modules is the main checkout\'s is unlinked, dangling links too', async () => {
  const { main, worktree, cleanup } = layout();
  try {
    fs.symlinkSync(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'));
    fs.symlinkSync(path.join(main, 'gone'), path.join(worktree, 'packages', 'p', 'node_modules'));
    const removed = await removeEscapingDependencyLinks(worktree);
    assert.deepEqual(removed.map(entry => entry.link).sort(), ['node_modules', 'packages/p/node_modules']);
    assert.ok(fs.existsSync(path.join(main, 'node_modules', 'left-pad')));
  } finally {
    cleanup();
  }
});

test('a worktree with real installed packages is left exactly as it is', async () => {
  const { worktree, cleanup } = layout();
  try {
    fs.mkdirSync(path.join(worktree, 'node_modules', 'left-pad'), { recursive: true });
    assert.deepEqual(await removeEscapingDependencyLinks(worktree), []);
    assert.ok(fs.existsSync(path.join(worktree, 'node_modules', 'left-pad')));
  } finally {
    cleanup();
  }
});
