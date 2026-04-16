import * as assert from 'assert';
import * as vscode from 'vscode';
import { identifyPlanFolder, parsePlanFolder } from '../livefolder/markdownPlanParser';

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
    const identified = await identifyPlanFolder(selectedUri);

    assert.strictEqual(identified.plansRootUri.fsPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootUri.fsPath, fixture.featuresRootUri.fsPath);
  });

  test('identifyPlanFolder normalizes a selected features folder back to the plans root', async () => {
    const fixture = await createLiveFolderFixture('selected-features-root');
    fixtureRoots.push(fixture.rootUri);

    const identified = await identifyPlanFolder(fixture.featuresRootUri);

    assert.strictEqual(identified.plansRootUri.fsPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootUri.fsPath, fixture.featuresRootUri.fsPath);
  });

  test('identifyPlanFolder accepts stored string paths with forward slashes', async () => {
    const fixture = await createLiveFolderFixture('forward-slash-string-path');
    fixtureRoots.push(fixture.rootUri);

    const selectedPath = fixture.rootUri.fsPath.replace(/\\/g, '/');
    const identified = await identifyPlanFolder(selectedPath);

    assert.strictEqual(identified.plansRootUri.fsPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(identified.featuresRootUri.fsPath, fixture.featuresRootUri.fsPath);
  });

  test('parsePlanFolder parses features and stories from an ancestor folder selection', async () => {
    const fixture = await createLiveFolderFixture('parse-from-ancestor');
    fixtureRoots.push(fixture.rootUri);

    const parsed = await parsePlanFolder(fixture.rootUri);

    assert.strictEqual(parsed.plansRootUri.fsPath, fixture.plansRootUri.fsPath);
    assert.strictEqual(parsed.featuresRootUri.fsPath, fixture.featuresRootUri.fsPath);
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

    const parsed = await parsePlanFolder(fixture.rootUri);
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

    // Place a bug file directly in the features/ root (not inside a feature dir)
    await writeTextFile(
      vscode.Uri.joinPath(fixture.featuresRootUri, 'bug-01-1-root-level-crash.md'),
      `# Root level crash

**Status:** To Do

## Summary
A bug filed at the features root, not inside a feature folder.
`
    );

    const parsed = await parsePlanFolder(fixture.rootUri);
    const rootBug = parsed.childItems.find(
      item => item.issueType === 'Bug' && item.title === 'Root level crash'
    );

    assert.ok(rootBug, 'Bug at features root should be discovered');
    assert.strictEqual(rootBug!.featureId, 1);
    assert.strictEqual(rootBug!.planStatus, 'To Do');
  });

  test('parsePlanFolder discovers bugs in plans/bugs/ subdirectory', async () => {
    const fixture = await createLiveFolderFixture('bugs-subdir');
    fixtureRoots.push(fixture.rootUri);

    // Place a bug file in plans/bugs/
    const bugsDirUri = vscode.Uri.joinPath(fixture.plansRootUri, 'bugs');
    await writeTextFile(
      vscode.Uri.joinPath(bugsDirUri, 'bug-01-2-payment-error.md'),
      `# Payment error

**Status:** In Progress

## Summary
Payment processing fails intermittently.
`
    );

    const parsed = await parsePlanFolder(fixture.rootUri);
    const subdirBug = parsed.childItems.find(
      item => item.issueType === 'Bug' && item.title === 'Payment error'
    );

    assert.ok(subdirBug, 'Bug in plans/bugs/ should be discovered');
    assert.strictEqual(subdirBug!.featureId, 1);
    assert.strictEqual(subdirBug!.planStatus, 'In Progress');
  });
});
