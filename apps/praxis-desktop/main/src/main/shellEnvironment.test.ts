import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ensureEnvironmentPath, getCandidateToolPaths, resolveShellPath } from './shellEnvironment';

test('ensureEnvironmentPath returns existing PATH on win32', () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = 'C:\\Windows\\System32;C:\\Program Files\\nodejs';
    const result = ensureEnvironmentPath({ platform: 'win32', force: true });
    assert.equal(result, 'C:\\Windows\\System32;C:\\Program Files\\nodejs');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('ensureEnvironmentPath merges shellPath ahead of existing PATH and deduplicates', () => {
  const originalPath = process.env.PATH;
  try {
    const initial = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    const shellPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].join(path.delimiter);
    const result = ensureEnvironmentPath({
      platform: 'darwin',
      force: true,
      initialPath: initial,
      shellPath,
      homeDir: '/nonexistent/home'
    });

    const parts = result.split(path.delimiter);
    assert.equal(parts[0], '/opt/homebrew/bin');
    assert.equal(parts[1], '/usr/local/bin');
    assert.equal(parts[2], '/usr/bin');
    // Ensure no duplicates
    const unique = new Set(parts);
    assert.equal(unique.size, parts.length);
    // process.env.PATH was updated
    assert.equal(process.env.PATH, result);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('ensureEnvironmentPath falls back to known existing directories when shellPath is undefined', () => {
  const originalPath = process.env.PATH;
  try {
    const initial = ['/usr/bin', '/bin'].join(path.delimiter);
    const result = ensureEnvironmentPath({
      platform: 'darwin',
      force: true,
      initialPath: initial,
      shellPath: undefined,
      homeDir: '/nonexistent/home'
    });

    const parts = result.split(path.delimiter);
    // Initial paths must be included
    assert.ok(parts.includes('/usr/bin'));
    assert.ok(parts.includes('/bin'));
    // If /opt/homebrew/bin exists on this machine, it should be included
    if (process.platform === 'darwin') {
      const fs = require('node:fs');
      if (fs.existsSync('/opt/homebrew/bin')) {
        assert.ok(parts.includes('/opt/homebrew/bin'));
      }
    }
  } finally {
    process.env.PATH = originalPath;
  }
});

test('getCandidateToolPaths builds expected tool paths under home directory', () => {
  const paths = getCandidateToolPaths('/mock/user');
  assert.ok(paths.includes(path.join('/mock/user', '.local', 'bin')));
  assert.ok(paths.includes(path.join('/mock/user', '.cargo', 'bin')));
  assert.ok(paths.includes(path.join('/mock/user', '.yarn', 'bin')));
  assert.ok(paths.includes(path.join('/mock/user', '.volta', 'bin')));
  assert.ok(paths.includes(path.join('/mock/user', '.fnm', 'current', 'bin')));
});

test('resolveShellPath returns undefined on invalid shell without throwing', () => {
  const result = resolveShellPath('/nonexistent/shell/binary');
  assert.equal(result, undefined);
});
