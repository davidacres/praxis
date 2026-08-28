import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  discoverPlanFolders,
  discoverRepositoryFolders,
  identifyPlanFolder,
  parsePlanFolder,
  setLiveFolderFs
} from '@praxis/core';
import { vsCodeLiveFolderFs } from '../adapters/vsCodeLiveFolderFs';

interface LiveFolderFixture {
  rootUri: vscode.Uri;
  plansRootUri: vscode.Uri;
  featuresRootUri: vscode.Uri;
}

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  const parentUri = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(parentUri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function createLiveFolderFixture(name: string): Promise<LiveFolderFixture> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('A workspace folder is required for markdown plan parser tests.');
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rootUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    '.ticket-manager-test',
    `${name}-${uniqueSuffix}`
  );
  const plansRootUri = vscode.Uri.joinPath(rootUri, 'product', 'docs', 'plans');
  const featuresRootUri = vscode.Uri.joinPath(plansRootUri, 'features');
  const featureDirUri = vscode.Uri.joinPath(featuresRootUri, 'feature-01-auth');

  await vscode.workspace.fs.createDirectory(featureDirUri);
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'feature.md'),
    `# Authentication

**Status:** Planned

## Summary
Implement authentication support.
`
  );
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'story-01-1-login-flow.md'),
    `# Login flow

**Status:** In Progress

## Summary
Build the first login story.
`
  );

  return { rootUri, plansRootUri, featuresRootUri };
}

suite('markdownPlanParser', () => {
  const fixtureRoots: vscode.Uri[] = [];

  suiteSetup(() => setLiveFolderFs(vsCodeLiveFolderFs));
  suiteTeardown(() => setLiveFolderFs(undefined));

  teardown(async () => {
    while (fixtureRoots.length > 0) {
      const fixtureRoot = fixtureRoots.pop();
      if (!fixtureRoot) {
        continue;
      }
      try {
        await vscode.workspace.fs.delete(fixtureRoot, { recursive: true, useTrash: false });
      } catch {
        // Ignore cleanup failures so one test does not hide the next failure.
      }
    }
  });

  test('identifyPlanFolder finds a nested plans root from a parent folder', async () => {
    const fixture = await createLiveFolderFixture('nested-plans-root');
    fixtureRoots.push(fixture.rootUri);

    const selectedUri = vscode.Uri.joinPath(fixture.rootUri, 'product');
    const identified = await identifyPlanFolder(selectedUri.fsPath);

    assert.strictEqual(identified.plansRootPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootPath, fixture.featuresRootUri.fsPath);
  });

  test('discoverPlanFolders finds every repository plans root under a matching parent', async () => {
    const first = await createLiveFolderFixture('multi-repo-first');
    const second = await createLiveFolderFixture('multi-repo-second');
    const parentUri = vscode.Uri.joinPath(first.rootUri, '..', 'multi-repo-parent');
    fixtureRoots.push(first.rootUri, second.rootUri, parentUri);

    await vscode.workspace.fs.createDirectory(parentUri);
    await vscode.workspace.fs.rename(first.rootUri, vscode.Uri.joinPath(parentUri, 'repo-one'));
    await vscode.workspace.fs.rename(second.rootUri, vscode.Uri.joinPath(parentUri, 'repo-two'));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(parentUri, 'README.md'),
      Buffer.from('**Type:** Story\n', 'utf8')
    );

    const matches = await discoverPlanFolders(parentUri.fsPath);

    assert.deepStrictEqual(
      matches.map(match => match.plansRootPath).sort(),
      [
        vscode.Uri.joinPath(parentUri, 'repo-one', 'product', 'docs', 'plans').fsPath,
        vscode.Uri.joinPath(parentUri, 'repo-two', 'product', 'docs', 'plans').fsPath
      ].sort()
    );
  });

  test('discoverRepositoryFolders finds empty parent and child repositories', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('A workspace folder is required for repository discovery tests.');
    }
    const parentUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.ticket-manager-test',
      `empty-repositories-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const repoOneUri = vscode.Uri.joinPath(parentUri, 'repo-one');
    const repoTwoUri = vscode.Uri.joinPath(parentUri, 'repo-two');
    fixtureRoots.push(parentUri);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(parentUri, '.git'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(repoOneUri, '.git'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(repoTwoUri, '.git'));

    const matches = await discoverRepositoryFolders(parentUri.fsPath);

    assert.deepStrictEqual(
      matches.map(match => match).sort(),
      [parentUri.fsPath, repoOneUri.fsPath, repoTwoUri.fsPath].sort()
    );
  });

  test('identifyPlanFolder accepts an explicitly selected empty folder', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('A workspace folder is required for empty-folder tests.');
    }
    const emptyUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.ticket-manager-test',
      `empty-plans-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fixtureRoots.push(emptyUri);
    await vscode.workspace.fs.createDirectory(emptyUri);

    const identified = await identifyPlanFolder(emptyUri.fsPath);

    assert.strictEqual(identified.plansRootPath, emptyUri.fsPath);
    // No features/ directory is required, and none is created just to validate.
    const entries = await vscode.workspace.fs.readDirectory(emptyUri);
    assert.deepStrictEqual(entries, []);
  });

  test('identifyPlanFolder accepts a folder holding only loose ticket markdown', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('A workspace folder is required for loose-ticket tests.');
    }
    const plansUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.ticket-manager-test',
      `loose-tickets-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fixtureRoots.push(plansUri);
    await writeTextFile(
      vscode.Uri.joinPath(plansUri, 'bug-001-login-fails.md'),
      '# Login fails\n\n**Status:** To Do\n**Type:** Bug\n'
    );

    const identified = await identifyPlanFolder(plansUri.fsPath);
    const parsed = await parsePlanFolder(plansUri.fsPath);

    assert.strictEqual(identified.plansRootPath, plansUri.fsPath);
    assert.strictEqual(parsed.childItems.length, 1);
    assert.strictEqual(parsed.childItems[0].issueType, 'Bug');
  });

  test('discoverPlanFolders ignores C# source folders named Features', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('A workspace folder is required for source-folder tests.');
    }
    const repoUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.ticket-manager-test',
      `csharp-features-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const sourceFeaturesUri = vscode.Uri.joinPath(repoUri, 'Example.Integration.Engine', 'Features');
    fixtureRoots.push(repoUri);

    await vscode.workspace.fs.createDirectory(sourceFeaturesUri);
    for (const fileName of ['FeatureConstants.cs', 'FeatureHelper.cs', 'IFeatureHelper.cs']) {
      await writeTextFile(
        vscode.Uri.joinPath(sourceFeaturesUri, fileName),
        'namespace Example.Integration.Engine.Features;\n'
      );
    }

    const matches = await discoverPlanFolders(repoUri.fsPath);

    assert.deepStrictEqual(
      matches.map(match => match.plansRootPath),
      [],
      'C# source folders must not be detected as plans roots'
    );
  });

  test('identifyPlanFolder keeps a selected parent plans root when child plans exist', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('A workspace folder is required for direct plans-root tests.');
    }
    const parentUri = vscode.Uri.joinPath(
      workspaceFolder.uri,
      '.ticket-manager-test',
      `parent-with-child-plans-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const childFeatureUri = vscode.Uri.joinPath(
      parentUri,
      'workspace',
      'child-repo',
      'features',
      'feature-01-child'
    );
    fixtureRoots.push(parentUri);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(parentUri, 'features'));
    await vscode.workspace.fs.createDirectory(childFeatureUri);
    await writeTextFile(
      vscode.Uri.joinPath(childFeatureUri, 'feature.md'),
      '# Child feature\n\n**Status:** Planned\n'
    );

    const identified = await identifyPlanFolder(parentUri.fsPath);

    assert.strictEqual(identified.plansRootPath, parentUri.fsPath);
  });

  test('identifyPlanFolder normalizes a selected features folder back to the plans root', async () => {
    const fixture = await createLiveFolderFixture('selected-features-root');
    fixtureRoots.push(fixture.rootUri);

    const identified = await identifyPlanFolder(fixture.featuresRootUri.fsPath);

    assert.strictEqual(identified.plansRootPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootPath, fixture.featuresRootUri.fsPath);
  });

  test('identifyPlanFolder accepts stored string paths with forward slashes', async () => {
    const fixture = await createLiveFolderFixture('forward-slash-string-path');
    fixtureRoots.push(fixture.rootUri);

    const selectedPath = fixture.rootUri.fsPath.replace(/\\/g, '/');
    const identified = await identifyPlanFolder(selectedPath);

    assert.strictEqual(identified.plansRootPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootPath, fixture.featuresRootUri.fsPath);
  });

  test('parsePlanFolder parses features and stories from an ancestor folder selection', async () => {
    const fixture = await createLiveFolderFixture('parse-from-ancestor');
    fixtureRoots.push(fixture.rootUri);

    const parsed = await parsePlanFolder(fixture.rootUri.fsPath);

    assert.strictEqual(parsed.plansRootPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(parsed.featuresRootPath, fixture.featuresRootUri.fsPath);
    assert.strictEqual(parsed.features.length, 1);
    assert.strictEqual(parsed.stories.length, 1);
    assert.strictEqual(parsed.childItems.length, 1);
    assert.strictEqual(parsed.features[0]?.title, 'Authentication');
    assert.strictEqual(parsed.stories[0]?.title, 'Login flow');
  });

  test('parsePlanFolder also captures task and bug markdown files as child items', async () => {
    const fixture = await createLiveFolderFixture('parse-child-items');
    fixtureRoots.push(fixture.rootUri);

    const featureDirUri = vscode.Uri.joinPath(fixture.featuresRootUri, 'feature-01-auth');
    await writeTextFile(
      vscode.Uri.joinPath(featureDirUri, 'task-01-1-harden-auth-logging.md'),
      `# Harden auth logging

**Status:** To Do

## Summary
Improve structured auth logging.
`
    );
    await writeTextFile(
      vscode.Uri.joinPath(featureDirUri, 'bug-01-1-fix-login-timeout.md'),
      `# Fix login timeout

**Status:** Proposed

## Summary
Resolve the timeout when refreshing tokens.
`
    );

    const parsed = await parsePlanFolder(fixture.rootUri.fsPath);
    const childTypes = parsed.childItems.map(item => item.issueType).sort();

    assert.deepStrictEqual(childTypes, ['Bug', 'Story', 'Task']);
    assert.strictEqual(
      parsed.childItems.find(item => item.issueType === 'Bug')?.title,
      'Fix login timeout'
    );
  });

  test('parsePlanFolder picks up child items at the features root level', async () => {
    const fixture = await createLiveFolderFixture('root-level-children');
    fixtureRoots.push(fixture.rootUri);

    await writeTextFile(
      vscode.Uri.joinPath(fixture.featuresRootUri, 'bug-01-1-root-level-crash.md'),
      `# Root level crash

**Status:** To Do

## Summary
A bug filed at the features root, not inside a feature folder.
`
    );

    const parsed = await parsePlanFolder(fixture.rootUri.fsPath);
    const rootBug = parsed.childItems.find(
      item => item.issueType === 'Bug' && item.title === 'Root level crash'
    );

    assert.ok(rootBug, 'Bug at features root should be discovered');
    assert.strictEqual(rootBug!.featureId, 1);
    assert.strictEqual(rootBug!.planStatus, 'To Do');
  });

  test('parsePlanFolder discovers bugs with loose filename format (bug-NNN-sRef-slug)', async () => {
    const fixture = await createLiveFolderFixture('bugs-loose');
    fixtureRoots.push(fixture.rootUri);

    const bugsDirUri = vscode.Uri.joinPath(fixture.plansRootUri, 'bugs');
    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-001-s107-isyncresultbuilder.md'),
      `# ISyncResultBuilder null ref

**Status:** Open

## Summary
NullReferenceException in ISyncResultBuilder when sync completes.
`
    );

    const parsed = await parsePlanFolder(fixture.rootUri.fsPath);
    const looseBug = parsed.childItems.find(
      item => item.issueType === 'Bug' && item.title === 'ISyncResultBuilder null ref'
    );

    assert.ok(looseBug, 'Bug with loose filename format should be discovered');
    assert.strictEqual(looseBug!.featureId, undefined, 'Loose-format bugs have no featureId');
    assert.strictEqual(looseBug!.sequence, 1);
    assert.strictEqual(looseBug!.planStatus, 'Backlog', 'Open maps to Backlog status');
  });

  test('parsePlanFolder works with only plans/bugs/ and no feature folders', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rootUri = vscode.Uri.joinPath(
      workspaceFolder!.uri,
      '.ticket-manager-test',
      `bugs-only-${uniqueSuffix}`
    );
    fixtureRoots.push(rootUri);
    const plansUri = vscode.Uri.joinPath(rootUri, 'plans');
    const bugsDirUri = vscode.Uri.joinPath(plansUri, 'bugs');

    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-001-s107-null-ref.md'),
      `# Null reference in sync

**Status:** In Progress

## Summary
NullReferenceException during sync.
`
    );
    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-002-s107-timeout.md'),
      `# Timeout in sync manager

**Status:** Done

## Summary
Sync manager times out after 30s.
`
    );

    const parsed = await parsePlanFolder(rootUri.fsPath);
    assert.strictEqual(parsed.features.length, 0, 'No features expected');
    assert.strictEqual(parsed.childItems.length, 2, 'Both bugs should be discovered');
    const bug1 = parsed.childItems.find(i => i.sequence === 1);
    const bug2 = parsed.childItems.find(i => i.sequence === 2);
    assert.ok(bug1, 'Bug 001 should be found');
    assert.ok(bug2, 'Bug 002 should be found');
    assert.strictEqual(bug1!.issueType, 'Bug');
    assert.strictEqual(bug2!.issueType, 'Bug');
  });

  test('parsePlanFolder discovers bugs alongside features', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rootUri = vscode.Uri.joinPath(
      workspaceFolder!.uri,
      '.ticket-manager-test',
      `mixed-${uniqueSuffix}`
    );
    fixtureRoots.push(rootUri);
    const plansUri = vscode.Uri.joinPath(rootUri, 'plans');

    const featureDirUri = vscode.Uri.joinPath(plansUri, 'features', 'feature-01-his-connectivity');
    await writeTextFile(
      vscode.Uri.joinPath(featureDirUri, 'feature.md'),
      `# HIS Connectivity

**Status:** Done

## Summary
Connect to HIS.
`
    );

    const bugsDirUri = vscode.Uri.joinPath(plansUri, 'bugs');
    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-001-s107-isyncresultbuilder.md'),
      `# ISyncResultBuilder null ref

**Status:** In Progress

## Summary
Null ref.
`
    );
    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-004-s3776-syncmanager-106.md'),
      `# SyncManager 106

**Status:** Backlog

## Summary
Sync issue.
`
    );

    const parsed = await parsePlanFolder(rootUri.fsPath);
    assert.strictEqual(parsed.features.length, 1, 'One feature expected');
    assert.strictEqual(
      parsed.childItems.filter(i => i.issueType === 'Bug').length,
      2,
      'Both bugs should be discovered alongside features'
    );
    const bug1 = parsed.childItems.find(i => i.issueType === 'Bug' && i.sequence === 1);
    assert.ok(bug1, 'bug-001-s107 should be discovered');
    assert.strictEqual(bug1!.featureId, undefined, 'Loose bug has no featureId');
  });
});
