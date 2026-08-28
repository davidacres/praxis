import * as assert from 'assert';
import * as vscode from 'vscode';
import { LiveFolderService, setLiveFolderFs, setLiveFolderWatch } from '@praxis/core';
import { vsCodeLiveFolderFs, vsCodeLiveFolderWatch } from '../adapters/vsCodeLiveFolderFs';

const WORKSPACE_ROOT_URI = vscode.workspace.workspaceFolders?.[0]?.uri;

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  const directory = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function createPlansFixture(
  suiteRoot: vscode.Uri,
  folderName: string
): Promise<{ plansRootUri: vscode.Uri; featureDirUri: vscode.Uri; featureKey: string }> {
  const plansRootUri = vscode.Uri.joinPath(suiteRoot, folderName, 'docs', 'plans');
  const featureDirUri = vscode.Uri.joinPath(plansRootUri, 'features', 'feature-01-existing-work');

  await vscode.workspace.fs.createDirectory(featureDirUri);
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'feature.md'),
    `# Existing Work

**Status:** Planned
**Created:** 2026-01-01T00:00:00.000Z

## Summary
Existing feature summary.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
`
  );

  return { plansRootUri, featureDirUri, featureKey: 'TEST-F01' };
}

function createService(plansRootFsPath: string): LiveFolderService {
  return new LiveFolderService({
    getDefaultPageSize: () => 50,
    getLiveFolderPath: () => plansRootFsPath,
    getLiveFolderProjectKey: () => 'TEST',
    getLiveFolderProjectName: () => 'Test Project',
    getLiveFolderAllowIssueCreation: () => true,
    getAiDefaultModel: () => ''
  });
}

suite('LiveFolderService createIssue', () => {
  let suiteRoot: vscode.Uri;
  let service: LiveFolderService | undefined;

  // Exercise core's LiveFolderService through the extension's real file IO.
  suiteSetup(() => {
    setLiveFolderFs(vsCodeLiveFolderFs);
    setLiveFolderWatch(vsCodeLiveFolderWatch);
  });
  suiteTeardown(() => {
    setLiveFolderFs(undefined);
    setLiveFolderWatch(undefined);
  });

  setup(async () => {
    if (!WORKSPACE_ROOT_URI) {
      throw new Error('A workspace folder is required for live folder tests.');
    }
    suiteRoot = vscode.Uri.joinPath(WORKSPACE_ROOT_URI, '.tmp-live-folder-tests');
    try {
      await vscode.workspace.fs.delete(suiteRoot, { recursive: true, useTrash: false });
    } catch {
      // Ignore missing fixture root.
    }
    await vscode.workspace.fs.createDirectory(suiteRoot);
  });

  teardown(async () => {
    service?.dispose();
    service = undefined;
    try {
      await vscode.workspace.fs.delete(suiteRoot, { recursive: true, useTrash: false });
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

  test('creates the feature inline when newParentSummary names no existing feature', async () => {
    const fixture = await createPlansFixture(suiteRoot, 'inline-create');
    service = createService(fixture.plansRootUri.fsPath);

    const created = await service.createIssue({
      projectKey: 'TEST',
      issueType: 'Story',
      summary: 'Add login rate limiting',
      newParentSummary: 'Billing Rework'
    });

    // The new feature is feature-02 (feature-01 exists) and the story lands inside it.
    assert.strictEqual(created.key, 'TEST-S02-1');
    assert.strictEqual(created.parentKey, 'TEST-F02');

    const newFeatureDir = vscode.Uri.joinPath(
      fixture.plansRootUri,
      'features',
      'feature-02-billing-rework'
    );
    const featureMdUri = vscode.Uri.joinPath(newFeatureDir, 'feature.md');
    assert.ok(await pathExists(featureMdUri), 'feature.md should exist for the new feature');
    assert.ok(
      await pathExists(vscode.Uri.joinPath(newFeatureDir, 'story-02-1-add-login-rate-limiting.md')),
      'the story file should be written inside the new feature folder'
    );

    const featureMd = Buffer.from(await vscode.workspace.fs.readFile(featureMdUri)).toString('utf8');
    assert.ok(featureMd.includes('# Billing Rework'), 'feature.md carries the new feature title');
    assert.ok(
      featureMd.includes('Add login rate limiting'),
      'the child row is appended to the new feature items table'
    );

    const parent = await service.getIssue('TEST-F02');
    assert.strictEqual(parent.issueType, 'Feature');
    assert.strictEqual(parent.summary, 'Billing Rework');
  });

  test('prefers an explicit parentKey over newParentSummary', async () => {
    const fixture = await createPlansFixture(suiteRoot, 'explicit-parent');
    service = createService(fixture.plansRootUri.fsPath);

    const created = await service.createIssue({
      projectKey: 'TEST',
      issueType: 'Task',
      summary: 'Wire up telemetry',
      parentKey: fixture.featureKey,
      newParentSummary: 'Should Not Be Created'
    });

    assert.strictEqual(created.parentKey, fixture.featureKey);
    assert.strictEqual(created.key, 'TEST-T01-1');
    assert.ok(
      await pathExists(
        vscode.Uri.joinPath(fixture.featureDirUri, 'task-01-1-wire-up-telemetry.md')
      ),
      'the task file belongs to the existing feature folder'
    );
    assert.ok(
      !(await pathExists(
        vscode.Uri.joinPath(fixture.plansRootUri, 'features', 'feature-02-should-not-be-created')
      )),
      'no feature is created when parentKey is supplied'
    );
  });

  test('treats whitespace-only newParentSummary as absent and still requires a parent', async () => {
    const fixture = await createPlansFixture(suiteRoot, 'blank-new-parent');
    service = createService(fixture.plansRootUri.fsPath);

    await assert.rejects(
      () =>
        service!.createIssue({
          projectKey: 'TEST',
          issueType: 'Bug',
          summary: 'Crash on save',
          newParentSummary: '   '
        }),
      /Feature is required for Bug items\./
    );
  });

  test('bootstraps an empty board: first child creates its feature folder', async () => {
    const plansRootUri = vscode.Uri.joinPath(suiteRoot, 'empty-board', 'docs', 'plans');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(plansRootUri, 'features'));
    service = createService(plansRootUri.fsPath);

    const created = await service.createIssue({
      projectKey: 'TEST',
      issueType: 'Story',
      summary: 'First real story',
      newParentSummary: 'Foundations'
    });

    assert.strictEqual(created.key, 'TEST-S01-1');
    assert.strictEqual(created.parentKey, 'TEST-F01');
    assert.ok(
      await pathExists(
        vscode.Uri.joinPath(plansRootUri, 'features', 'feature-01-foundations', 'feature.md')
      )
    );
  });
});
