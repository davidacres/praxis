import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedDiff } from './unifiedDiff';

test('returns empty string when content is unchanged', () => {
  assert.equal(createUnifiedDiff('a.txt', 'same\n', 'same\n'), '');
});

test('emits an addition hunk for a new file', () => {
  const diff = createUnifiedDiff('notes.md', '', 'line one\nline two\n');
  assert.match(diff, /^--- notes\.md\n\+\+\+ notes\.md\n/);
  assert.match(diff, /\n\+line one\n/);
  assert.match(diff, /\n\+line two\n/);
  assert.doesNotMatch(diff, /\n-/);
});

test('emits deletions and additions for a modified region with context', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nCHANGED\nd\ne\n';
  const diff = createUnifiedDiff('f.txt', before, after);
  assert.match(diff, /\n-c\n/);
  assert.match(diff, /\n\+CHANGED\n/);
  // context lines are prefixed with a space
  assert.match(diff, /\n b\n/);
  assert.match(diff, /\n d\n/);
});

test('hunk header line counts match the emitted body', () => {
  const diff = createUnifiedDiff('f.txt', 'a\nb\nc\n', 'a\nX\nc\n');
  const header = diff.split('\n').find(line => line.startsWith('@@'));
  assert.ok(header, 'expected a hunk header');
  const match = header!.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
  assert.ok(match, `unexpected hunk header: ${header}`);
  const [, , oldCount, , newCount] = match!.map(Number);
  const body = diff.split('\n').slice(3).filter(line => line.length > 0);
  assert.equal(body.filter(l => l.startsWith(' ') || l.startsWith('-')).length, oldCount);
  assert.equal(body.filter(l => l.startsWith(' ') || l.startsWith('+')).length, newCount);
});
