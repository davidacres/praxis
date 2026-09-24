import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionRecord, GitDiffDocument, GitStatusSnapshot } from '@praxis/core';
import { readMobileSessionChanges, readMobileSessionFileDiff, type MobileSessionChangesGit } from './mobileSessionChanges';

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    issueKey: 'S-1', sessionId: 's1', title: 'x', state: 'completed', taskDefinition: { goal: 'x', scope: 'repo', definitionOfDone: 'done' },
    mode: 'chat', stepCount: 1, startedAt: '2026-09-22T09:00:00.000Z', workingDirectory: '/repo',
    events: [{ timestamp: '2026-09-22T09:00:00.000Z', type: 'tool_complete', summary: 'edit', data: { fileChanges: [{ path: '/repo/src/b.ts' }] } }],
    ...overrides,
  };
}

const STATUS: GitStatusSnapshot = {
  repositoryPath: '/repo', branch: 'main', ahead: 0, behind: 0,
  files: [
    { path: 'README.md', indexStatus: ' ', worktreeStatus: 'M', staged: false, additions: 1, deletions: 1 },
    { path: 'src/b.ts', indexStatus: ' ', worktreeStatus: 'M', staged: false, additions: 3, deletions: 0 },
    { path: 'src/new.ts', indexStatus: '?', worktreeStatus: '?', staged: false },
  ],
};

function git(lines = 3): MobileSessionChangesGit & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    status: async () => STATUS,
    comparison: async (_repo, request) => {
      requested.push(request.path ?? '');
      return {
        request, title: '', subtitle: '', generatedAt: '2026-09-22T09:00:00.000Z', additions: lines, deletions: 0,
        files: [{
          id: 'f', displayPath: request.path ?? '', status: 'modified', additions: lines, deletions: 0, isBinary: false,
          hunks: [{ id: 'h', header: '@@ -1 +1,3 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: lines, patch: '',
            lines: Array.from({ length: lines }, (_, index) => ({ kind: 'addition' as const, content: `line ${index}`, newLineNumber: index + 1 })) }],
        }],
      } satisfies GitDiffDocument;
    },
  };
}

test('lists relative paths with the session\'s own edits first', async () => {
  const changes = await readMobileSessionChanges(record(), git());
  assert.equal(changes.repository, true);
  assert.deepEqual(changes.files.map(file => [file.path, file.status, file.reportedBySession]), [
    ['src/b.ts', 'modified', true],
    ['README.md', 'modified', false],
    ['src/new.ts', 'added', false],
  ]);
});

test('a folder that is not a repository reads as nothing to compare, not an error', async () => {
  const changes = await readMobileSessionChanges(record(), { status: async () => { throw new Error('not a git repository'); }, comparison: async () => { throw new Error('unused'); } });
  assert.deepEqual(changes, { sessionId: 's1', repository: false, files: [] });
});

test('a diff is served only for a path the session\'s status lists, and bounded', async () => {
  const fake = git(10);
  await assert.rejects(readMobileSessionFileDiff(record(), '../../etc/passwd', fake), /no uncommitted change/);
  assert.deepEqual(fake.requested, []);
  const diff = await readMobileSessionFileDiff(record(), 'src/b.ts', fake, 4);
  assert.equal(diff.truncated, true);
  assert.equal(diff.hunks[0].lines.length, 4);
  assert.deepEqual(diff.hunks[0].lines[0], { kind: 'add', text: 'line 0', newLine: 1 });
});
