import * as assert from 'assert';
import {
  planBoardDrafts,
  validateBoardDrafts,
  type BoardDraftRow
} from '../userWorkspace/boardDraftPlanner';

const PARENT = 'C:\\dev-int';
const ENGINE = 'C:\\dev-int\\workspace\\Engine\\Traka.Integration.Engine';
const NETBOX = 'C:\\dev-int\\workspace\\Integrations\\Traka.Integration.NetBox';
const S2NETBOX = 'C:\\dev-int\\workspace\\Integrations\\Traka.Integration.S2NetBox';

function repos(...rootPaths: string[]): Array<{ rootPath: string }> {
  return rootPaths.map(rootPath => ({ rootPath }));
}

suite('boardDraftPlanner', () => {
  test('creates one row per repository using canonical docs/plans', () => {
    const rows = planBoardDrafts({
      repositories: repos(PARENT, ENGINE, NETBOX),
      planRoots: []
    });

    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(
      rows.map(row => row.liveFolderPath),
      [
        'C:/dev-int/docs/plans',
        'C:/dev-int/workspace/Engine/Traka.Integration.Engine/docs/plans',
        'C:/dev-int/workspace/Integrations/Traka.Integration.NetBox/docs/plans'
      ]
    );
    assert.strictEqual(rows.every(row => !row.alreadyAdded), true);
  });

  test('parent repository does not adopt a child repository plans folder', () => {
    const rows = planBoardDrafts({
      repositories: repos(PARENT, ENGINE),
      planRoots: [
        { plansPath: `${ENGINE}\\docs\\plans`, featureEntryCount: 1 }
      ]
    });

    const parentRow = rows.find(row => row.repositoryRootPath === 'C:/dev-int');
    const engineRow = rows.find(row => row.repositoryRootPath.endsWith('Traka.Integration.Engine'));
    assert.strictEqual(parentRow?.liveFolderPath, 'C:/dev-int/docs/plans');
    assert.strictEqual(
      engineRow?.liveFolderPath,
      'C:/dev-int/workspace/Engine/Traka.Integration.Engine/docs/plans'
    );
  });

  test('ignores an orphaned empty features marker at the repository root', () => {
    // Left behind by an interrupted run: repository root looked like a plans root
    // because it contained an empty features/ directory.
    const rows = planBoardDrafts({
      repositories: repos(ENGINE),
      planRoots: [{ plansPath: ENGINE, featureEntryCount: 0 }]
    });

    assert.strictEqual(
      rows[0].liveFolderPath,
      'C:/dev-int/workspace/Engine/Traka.Integration.Engine/docs/plans'
    );
  });

  test('keeps a registered legacy plans root at the repository root', () => {
    const rows = planBoardDrafts({
      repositories: repos(ENGINE),
      planRoots: [{ plansPath: ENGINE, featureEntryCount: 0 }],
      existingPaths: ['C:/dev-int/workspace/Engine/Traka.Integration.Engine']
    });

    assert.strictEqual(
      rows[0].liveFolderPath,
      'C:/dev-int/workspace/Engine/Traka.Integration.Engine'
    );
    assert.strictEqual(rows[0].alreadyAdded, true);
  });

  test('flags already added boards so they are never created twice', () => {
    const rows = planBoardDrafts({
      repositories: repos(PARENT, ENGINE),
      planRoots: [],
      existingPaths: ['c:/dev-int/docs/plans']
    });

    const parentRow = rows.find(row => row.liveFolderPath === 'C:/dev-int/docs/plans');
    const engineRow = rows.find(row => row.liveFolderPath.includes('Engine'));
    assert.strictEqual(parentRow?.alreadyAdded, true, 'existing path matches case-insensitively');
    assert.strictEqual(engineRow?.alreadyAdded, false);
  });

  test('generates unique project codes for similarly named repositories', () => {
    const rows = planBoardDrafts({
      repositories: repos(NETBOX, S2NETBOX, ENGINE),
      planRoots: []
    });

    const keys = rows.map(row => row.projectKey);
    assert.strictEqual(new Set(keys).size, keys.length, `expected unique keys, got ${keys.join(', ')}`);
    assert.strictEqual(keys.every(key => /^[A-Z][A-Z0-9_]{0,14}$/.test(key)), true);
  });

  test('generated codes never collide with existing board codes', () => {
    const existing = planBoardDrafts({ repositories: repos(NETBOX), planRoots: [] })[0].projectKey;
    const rows = planBoardDrafts({
      repositories: repos(NETBOX),
      planRoots: [],
      existingKeys: [existing]
    });

    assert.notStrictEqual(rows[0].projectKey, existing);
    assert.match(rows[0].projectKey, /^[A-Z][A-Z0-9_]{0,14}$/);
  });

  test('falls back to plans roots when no Git repositories are found', () => {
    const rows = planBoardDrafts({
      repositories: [],
      planRoots: [{ plansPath: 'C:\\plans\\alpha', featureEntryCount: 2 }]
    });

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].liveFolderPath, 'C:/plans/alpha');
  });

  suite('validateBoardDrafts', () => {
    function row(overrides: Partial<BoardDraftRow> = {}): BoardDraftRow {
      return {
        repositoryName: 'Repo',
        repositoryRootPath: 'C:/repo',
        liveFolderPath: 'C:/repo/docs/plans',
        projectKey: 'REPO',
        projectName: 'Repo',
        name: 'Repo',
        alreadyAdded: false,
        ...overrides
      };
    }

    test('accepts valid unique rows', () => {
      assert.strictEqual(
        validateBoardDrafts([row(), row({ projectKey: 'OTHER', liveFolderPath: 'C:/other' })]),
        undefined
      );
    });

    test('rejects duplicate project codes', () => {
      const error = validateBoardDrafts([row(), row({ liveFolderPath: 'C:/other' })]);
      assert.match(String(error), /used more than once/);
    });

    test('rejects a code already used by an existing board', () => {
      const error = validateBoardDrafts([row()], ['REPO']);
      assert.match(String(error), /used more than once/);
    });

    test('rejects invalid project codes', () => {
      assert.match(String(validateBoardDrafts([row({ projectKey: '1BAD' })])), /invalid/);
      assert.match(String(validateBoardDrafts([row({ projectKey: '' })])), /invalid/);
      assert.match(
        String(validateBoardDrafts([row({ projectKey: 'WAYTOOLONGPROJECTCODE' })])),
        /invalid/
      );
    });

    test('rejects blank names', () => {
      assert.match(String(validateBoardDrafts([row({ name: '   ' })])), /project name and board name/);
    });

    test('ignores already added rows during validation', () => {
      assert.strictEqual(
        validateBoardDrafts([row({ alreadyAdded: true, projectKey: '1INVALID' })]),
        undefined
      );
    });
  });
});
