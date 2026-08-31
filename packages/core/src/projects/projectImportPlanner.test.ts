import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { planProjectImports, validateProjectImports } from './projectImportPlanner';

const parent = path.resolve('/tmp/praxis-planner');
const repoA = path.join(parent, 'repo-a');
const repoB = path.join(parent, 'repo-b');

test('a repository whose plans sit outside docs/plans is paired with the real folder', () => {
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }],
    planRoots: [{ plansPath: path.join(repoA, 'planning'), featureEntryCount: 2 }]
  });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].plansFolderPath.endsWith('repo-a/planning'), rows[0].plansFolderPath);
});

test('a plans root at the repository root is kept even with zero feature entries', () => {
  // A folder tracking only bugs/tasks reports featureEntryCount 0. The old
  // planner treated that as an "orphan marker" and discarded it, then guessed
  // `docs/plans` — the path to a board that silently showed nothing.
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }],
    planRoots: [{ plansPath: repoA, featureEntryCount: 0 }]
  });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].plansFolderPath.endsWith('repo-a'), rows[0].plansFolderPath);
});

test('a repository with no discoverable plans is skipped, never guessed at', () => {
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }],
    planRoots: []
  });
  assert.deepEqual(rows, [], 'a plansless repo must not produce a docs/plans guess');
});

test('a parent repository never adopts a child repository\'s plans folder', () => {
  const nested = path.join(repoA, 'nested');
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }, { rootPath: nested }],
    planRoots: [{ plansPath: path.join(nested, 'plans'), featureEntryCount: 1 }]
  });
  // Only the nested repo owns that plans root; the parent has none and is skipped.
  assert.equal(rows.length, 1);
  assert.ok(rows[0].plansFolderPath.includes('nested'), rows[0].plansFolderPath);
});

test('with no repositories at all, bare plans roots each become a row', () => {
  const rows = planProjectImports({
    repositories: [],
    planRoots: [
      { plansPath: path.join(parent, 'plans-one'), featureEntryCount: 1 },
      { plansPath: path.join(parent, 'plans-two'), featureEntryCount: 0 }
    ]
  });
  assert.equal(rows.length, 2);
});

test('generated project keys are unique and avoid keys already in use', () => {
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }, { rootPath: repoB }],
    planRoots: [
      { plansPath: path.join(repoA, 'plans'), featureEntryCount: 1 },
      { plansPath: path.join(repoB, 'plans'), featureEntryCount: 1 }
    ],
    existingKeys: ['REPOA']
  });
  const keys = rows.map(row => row.projectKey);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
  assert.ok(!keys.includes('REPOA'), `collided with an existing key: ${keys.join(', ')}`);
});

test('an already-imported plans folder is flagged rather than offered again', () => {
  const plansPath = path.join(repoA, 'plans');
  const rows = planProjectImports({
    repositories: [{ rootPath: repoA }],
    planRoots: [{ plansPath, featureEntryCount: 1 }],
    existingPaths: [plansPath]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alreadyAdded, true);
});

test('validateProjectImports rejects malformed and duplicate keys', () => {
  const row = {
    repositoryName: 'Repo A',
    repositoryRootPath: repoA,
    plansFolderPath: path.join(repoA, 'plans'),
    projectKey: 'OK1',
    projectName: 'Repo A',
    alreadyAdded: false
  };
  assert.equal(validateProjectImports([row]), undefined);
  assert.match(validateProjectImports([{ ...row, projectKey: '1BAD' }]) ?? '', /invalid/i);
  assert.match(validateProjectImports([row], ['OK1']) ?? '', /more than once/i);
  assert.match(validateProjectImports([{ ...row, projectName: '  ' }]) ?? '', /project name/i);
});
