import * as assert from 'assert';
import * as vscode from 'vscode';
import { UserWorkspaceService } from '../userWorkspace/userWorkspaceService';
import { UserWorkspaceStore } from '../userWorkspace/userWorkspaceStore';
import { toStoredFolderPath } from '../livefolder/pathUtils';

class MemoryMemento {
  private store = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T) ?? defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  public keys(): readonly string[] {
    return [...this.store.keys()];
  }

  public setKeysForSync(): void {
    // no-op
  }
}

interface FixtureDefinition {
  folderName: string;
  featureTitle: string;
  storyTitle: string;
  projectKey: string;
  projectName: string;
}

const WORKSPACE_ROOT_URI = vscode.workspace.workspaceFolders?.[0]?.uri;

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  const directory = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function createUserWorkspaceFixture(
  suiteRoot: vscode.Uri,
  definition: FixtureDefinition
): Promise<{ plansRootUri: vscode.Uri; featureKey: string }> {
  const rootUri = vscode.Uri.joinPath(suiteRoot, definition.folderName);
  const plansRootUri = vscode.Uri.joinPath(rootUri, 'docs', 'plans');
  const featureDirUri = vscode.Uri.joinPath(plansRootUri, 'features', 'feature-01-main-work');
  const featureKey = `${definition.projectKey}-F01`;

  await vscode.workspace.fs.createDirectory(featureDirUri);
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'feature.md'),
    `# ${definition.featureTitle}

**Status:** Planned
**Created:** 2026-01-01T00:00:00.000Z

## Summary
${definition.featureTitle} summary.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| 1 | Story | ${definition.storyTitle} | In Progress |
`
  );
  await writeTextFile(
    vscode.Uri.joinPath(featureDirUri, 'story-01-1-main-story.md'),
    `# ${definition.storyTitle}

**Status:** In Progress
**Created:** 2026-01-02T00:00:00.000Z
**Type:** Story
**Parent:** ${featureKey}

## Summary
${definition.storyTitle} summary.
`
  );

  return {
    plansRootUri,
    featureKey
  };
}

suite('UserWorkspaceService', () => {
  let memento: vscode.Memento;
  let store: UserWorkspaceStore;
  let service: UserWorkspaceService;
  let suiteRoot: vscode.Uri;

  setup(async () => {
    if (!WORKSPACE_ROOT_URI) {
      throw new Error('A workspace folder is required for user workspace tests.');
    }
    memento = new MemoryMemento() as unknown as vscode.Memento;
    store = new UserWorkspaceStore(memento);
    service = new UserWorkspaceService(
      {
        getDefaultPageSize: () => 50,
        getLiveFolderAllowIssueCreation: () => true,
        getAiDefaultModel: () => ''
      },
      store
    );
    suiteRoot = vscode.Uri.joinPath(WORKSPACE_ROOT_URI, '.tmp-user-workspace-tests');
    try {
      await vscode.workspace.fs.delete(suiteRoot, { recursive: true, useTrash: false });
    } catch {
      // Ignore missing fixture root.
    }
    await vscode.workspace.fs.createDirectory(suiteRoot);
  });

  teardown(async () => {
    service.dispose();
    try {
      await vscode.workspace.fs.delete(suiteRoot, { recursive: true, useTrash: false });
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

  test('store persists user workspace board definitions', async () => {
    const created = await store.createBoard({
      name: 'Alpha Board',
      projectKey: 'ALPHA',
      projectName: 'Alpha Project',
      liveFolderPath: 'C:/plans/alpha'
    });

    const persisted = store.getBoards();
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].id, created.id);
    assert.strictEqual(persisted[0].projectKey, 'ALPHA');
    assert.strictEqual(persisted[0].projectName, 'Alpha Project');
    assert.strictEqual(persisted[0].liveFolderPath, 'C:/plans/alpha');
  });

  test('creates a board from an empty folder without writing any files', async () => {
    const plansRootUri = vscode.Uri.joinPath(suiteRoot, 'empty-repository', 'docs', 'plans');
    await vscode.workspace.fs.createDirectory(plansRootUri);

    const board = await service.createBoard({
      name: 'Empty Repository',
      projectKey: 'EMPTYREPO',
      projectName: 'Empty Repository',
      liveFolderPath: plansRootUri.fsPath
    });
    const details = await service.getBoardDetails(board);

    assert.strictEqual(details.board.locationName, toStoredFolderPath(plansRootUri.fsPath));
    assert.strictEqual(details.issues.length, 0, 'an empty board starts with no tickets');

    const entries = await vscode.workspace.fs.readDirectory(plansRootUri);
    assert.deepStrictEqual(entries, [], 'creating a board must not write anything to the folder');
  });

  test('aggregates boards from multiple plan folders and scopes board details', async () => {
    const appFixture = await createUserWorkspaceFixture(suiteRoot, {
      folderName: 'app-work',
      featureTitle: 'Authentication',
      storyTitle: 'Login flow',
      projectKey: 'APP',
      projectName: 'Application Platform'
    });
    const opsFixture = await createUserWorkspaceFixture(suiteRoot, {
      folderName: 'ops-work',
      featureTitle: 'Telemetry',
      storyTitle: 'Metrics dashboard',
      projectKey: 'OPS',
      projectName: 'Operations'
    });

    const appBoard = await service.createBoard({
      name: 'App Board',
      projectKey: 'APP',
      projectName: 'Application Platform',
      liveFolderPath: appFixture.plansRootUri.fsPath
    });
    const opsBoard = await service.createBoard({
      name: 'Ops Board',
      projectKey: 'OPS',
      projectName: 'Operations',
      liveFolderPath: opsFixture.plansRootUri.fsPath
    });

    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    assert.strictEqual(boards.length, 2);

    const allIssues = await service.getIssues(
      {
        projectKeys: [],
        statuses: [],
        issueTypes: [],
        searchText: '',
        assigneeMode: 'all',
        grouping: 'none'
      },
      0,
      50
    );
    assert.strictEqual(allIssues.total, 4);

    const appDetails = await service.getBoardDetails(appBoard);
    assert.strictEqual(appDetails.board.id, appBoard.id);
    assert.ok(appDetails.issues.every(issue => issue.projectKey === 'APP'));
    assert.ok(appDetails.issues.some(issue => issue.summary === 'Authentication'));
    assert.ok(appDetails.issues.some(issue => issue.summary === 'Login flow'));

    const opsDetails = await service.getBoardDetails(opsBoard);
    assert.strictEqual(opsDetails.board.id, opsBoard.id);
    assert.ok(opsDetails.issues.every(issue => issue.projectKey === 'OPS'));
    assert.ok(opsDetails.issues.some(issue => issue.summary === 'Telemetry'));
    assert.ok(opsDetails.issues.some(issue => issue.summary === 'Metrics dashboard'));
  });

  test('creates issues inside the selected user workspace board', async () => {
    const fixture = await createUserWorkspaceFixture(suiteRoot, {
      folderName: 'feature-work',
      featureTitle: 'Authentication',
      storyTitle: 'Login flow',
      projectKey: 'APP',
      projectName: 'Application Platform'
    });

    const board = await service.createBoard({
      name: 'App Board',
      projectKey: 'APP',
      projectName: 'Application Platform',
      liveFolderPath: fixture.plansRootUri.fsPath
    });

    const created = await service.createIssue({
      boardId: board.id,
      projectKey: 'APP',
      issueType: 'Bug',
      summary: 'Fix token refresh',
      parentKey: fixture.featureKey
    });

    assert.strictEqual(created.projectKey, 'APP');
    assert.strictEqual(created.issueType, 'Bug');

    const details = await service.getBoardDetails(board);
    assert.ok(details.issues.some(issue => issue.key === created.key));
  });

  test('passes newParentSummary through: creates the feature, then the issue under it', async () => {
    const fixture = await createUserWorkspaceFixture(suiteRoot, {
      folderName: 'inline-feature-work',
      featureTitle: 'Authentication',
      storyTitle: 'Login flow',
      projectKey: 'APP',
      projectName: 'Application Platform'
    });

    const board = await service.createBoard({
      name: 'App Board',
      projectKey: 'APP',
      projectName: 'Application Platform',
      liveFolderPath: fixture.plansRootUri.fsPath
    });

    const created = await service.createIssue({
      boardId: board.id,
      projectKey: 'APP',
      issueType: 'Story',
      summary: 'Password reset flow',
      newParentSummary: 'Account Management'
    });

    // feature-01 exists in the fixture, so the inline feature is feature-02.
    assert.strictEqual(created.parentKey, 'APP-F02');

    const details = await service.getBoardDetails(board);
    const newFeature = details.issues.find(issue => issue.key === 'APP-F02');
    assert.ok(newFeature, 'the new feature appears on the board');
    assert.strictEqual(newFeature.issueType, 'Feature');
    assert.strictEqual(newFeature.summary, 'Account Management');
    assert.ok(details.issues.some(issue => issue.key === created.key));
  });
});
