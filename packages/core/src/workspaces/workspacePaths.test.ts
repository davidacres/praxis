import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  resolvePortableFolderPath,
  isPortableFolderPath,
  toPortableFolderPath
} from './workspacePaths';

const HOME = path.resolve('/Users/someone/dev/praxis');

test('a folder inside the workspace file`s tree is stored relative to it', () => {
  assert.equal(toPortableFolderPath(HOME, HOME), '.');
  assert.equal(toPortableFolderPath(path.join(HOME, 'apps', 'web'), HOME), './apps/web');
  assert.equal(toPortableFolderPath(path.join(HOME, 'docs'), HOME), './docs');
});

test('a folder outside the tree stays absolute rather than being rewritten', () => {
  const elsewhere = path.resolve('/Users/someone/other/repo');
  assert.equal(toPortableFolderPath(elsewhere, HOME), elsewhere);
  // A sibling that merely shares a name prefix is still outside.
  const sibling = path.resolve('/Users/someone/dev/praxis-tools');
  assert.equal(toPortableFolderPath(sibling, HOME), sibling);
});

test('stored paths use POSIX separators so a file written on one OS opens on another', () => {
  const stored = toPortableFolderPath(path.join(HOME, 'a', 'b', 'c'), HOME);
  assert.equal(stored, './a/b/c');
  assert.ok(!stored.includes('\\'));
});

test('a relative path resolves against wherever the file now lives', () => {
  const moved = path.resolve('/somewhere/else/praxis');
  assert.equal(resolvePortableFolderPath('./apps/web', moved), path.join(moved, 'apps', 'web'));
  assert.equal(resolvePortableFolderPath('.', moved), moved);
});

test('an absolute stored path passes through untouched', () => {
  const elsewhere = path.resolve('/Users/someone/other/repo');
  assert.equal(resolvePortableFolderPath(elsewhere, HOME), elsewhere);
  // A Windows path read on POSIX is absolute to the machine that wrote it —
  // resolving it under the workspace folder would invent a nonsense location.
  assert.equal(resolvePortableFolderPath('C:\\work\\repo', HOME), 'C:\\work\\repo');
});

test('round-tripping an in-tree folder from a different absolute root still resolves', () => {
  const original = path.join(HOME, 'apps', 'web');
  const stored = toPortableFolderPath(original, HOME);
  const clonedTo = path.resolve('/build/agent/checkout');
  assert.equal(resolvePortableFolderPath(stored, clonedTo), path.join(clonedTo, 'apps', 'web'));
});

test('empty and already-relative inputs are left alone', () => {
  assert.equal(toPortableFolderPath('', HOME), '');
  assert.equal(toPortableFolderPath('./already', HOME), './already');
  assert.equal(resolvePortableFolderPath('', HOME), '');
});

test('isPortableFolderPath reports whether a stored path will travel', () => {
  assert.equal(isPortableFolderPath('./apps/web'), true);
  assert.equal(isPortableFolderPath('.'), true);
  assert.equal(isPortableFolderPath(path.resolve('/Users/someone/repo')), false);
  assert.equal(isPortableFolderPath('C:\\work\\repo'), false);
});
