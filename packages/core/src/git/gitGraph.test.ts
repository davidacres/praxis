import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitGraph } from './gitGraph';

test('marks merge and divergence topology and preserves branch hints', () => {
  const commits = [
    { hash: 'merge', parents: ['feature', 'main'], author: 'A', date: '2026-01-03', message: 'merge' },
    { hash: 'feature', parents: ['base'], author: 'A', date: '2026-01-02', message: 'feature' },
    { hash: 'main', parents: ['base'], author: 'A', date: '2026-01-02', message: 'main' },
    { hash: 'base', parents: [], author: 'A', date: '2026-01-01', message: 'base' }
  ];
  const graph = buildCommitGraph(
    commits,
    new Map([['merge', ['main']], ['feature', ['feature/topic']]]),
    [
      { name: 'main', ref: 'refs/heads/main', tip: 'merge', isRemote: false, isCurrent: true },
      { name: 'feature/topic', ref: 'refs/heads/feature/topic', tip: 'feature', isRemote: false, isCurrent: false }
    ]
  );
  assert.equal(graph.find(node => node.hash === 'merge')?.isMerge, true);
  assert.equal(graph.find(node => node.hash === 'base')?.isDivergence, true);
  assert.deepEqual(graph.find(node => node.hash === 'feature')?.branchHints, ['main', 'feature/topic']);
});

test('builds a 5,000-commit linear history without quadratic ancestry work', () => {
  const commits = Array.from({ length: 5000 }, (_, index) => ({
    hash: `commit-${index}`,
    parents: index === 0 ? [] : [`commit-${index - 1}`],
    author: 'A',
    date: '2026-01-01',
    message: `commit ${index}`
  })).reverse();
  const started = performance.now();
  const graph = buildCommitGraph(
    commits,
    new Map([['commit-4999', ['main']]]),
    [{ name: 'main', ref: 'refs/heads/main', tip: 'commit-4999', isRemote: false, isCurrent: true }]
  );
  const elapsed = performance.now() - started;
  assert.equal(graph.length, 5000);
  assert.ok(elapsed < 2000, `graph build took ${elapsed.toFixed(0)}ms`);
});

test('handles detached histories, multiple refs, and criss-cross merges', () => {
  const graph = buildCommitGraph(
    [
      { hash: 'merge-2', parents: ['merge-1', 'side-2'], author: 'A', date: '2026-01-04', message: 'merge two' },
      { hash: 'merge-1', parents: ['base', 'side-1'], author: 'A', date: '2026-01-03', message: 'merge one' },
      { hash: 'side-2', parents: ['side-1'], author: 'A', date: '2026-01-03', message: 'side two' },
      { hash: 'side-1', parents: ['base'], author: 'A', date: '2026-01-02', message: 'side one' },
      { hash: 'base', parents: [], author: 'A', date: '2026-01-01', message: 'base' }
    ],
    new Map([['merge-2', ['HEAD', 'refs/tags/v1']]]),
    []
  );
  assert.equal(graph.find(node => node.hash === 'merge-2')?.isMerge, true);
  assert.equal(graph.find(node => node.hash === 'merge-1')?.isMerge, true);
  assert.deepEqual(graph.find(node => node.hash === 'merge-2')?.refs, ['HEAD', 'refs/tags/v1']);
  assert.equal(graph.find(node => node.hash === 'base')?.lane, 0);
});
