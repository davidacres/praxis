import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOARD_CONFIG_FILENAME,
  readBoardConfigFile,
  writeBoardConfigFile
} from './boardConfigFile';
import { FolderService, type FolderConfigProvider } from './folderService';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-boardcfg-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('readBoardConfigFile returns {} when the file is missing or malformed', async () => {
  await withTempDir(async dir => {
    assert.deepEqual(await readBoardConfigFile(dir), {});
    await fs.writeFile(path.join(dir, BOARD_CONFIG_FILENAME), 'not json', 'utf8');
    assert.deepEqual(await readBoardConfigFile(dir), {});
    await fs.writeFile(path.join(dir, BOARD_CONFIG_FILENAME), '["array"]', 'utf8');
    assert.deepEqual(await readBoardConfigFile(dir), {});
  });
});

test('readBoardConfigFile keeps only well-typed known fields', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(
      path.join(dir, BOARD_CONFIG_FILENAME),
      JSON.stringify({ projectKey: ' APP ', projectName: 'My App', allowIssueCreation: true, junk: 1, projectKeyBad: 5 }),
      'utf8'
    );
    assert.deepEqual(await readBoardConfigFile(dir), {
      projectKey: 'APP',
      projectName: 'My App',
      allowIssueCreation: true
    });
  });
});

test('writeBoardConfigFile round-trips and omits empty fields', async () => {
  await withTempDir(async dir => {
    await writeBoardConfigFile(dir, { projectKey: 'APP', projectName: '', allowIssueCreation: false });
    const raw = JSON.parse(await fs.readFile(path.join(dir, BOARD_CONFIG_FILENAME), 'utf8'));
    assert.deepEqual(raw, { projectKey: 'APP', allowIssueCreation: false });
    assert.deepEqual(await readBoardConfigFile(dir), { projectKey: 'APP', allowIssueCreation: false });
  });
});

function stubConfig(dir: string, overrides: Partial<Record<string, unknown>> = {}): FolderConfigProvider {
  return {
    getDefaultPageSize: () => 25,
    getFolderRoots: () => [dir],
    getFolderProjectKey: () => (overrides.projectKey as string) ?? 'CONN',
    getFolderProjectName: () => (overrides.projectName as string) ?? 'Connection Board',
    getFolderAllowIssueCreation: () => (overrides.allowIssueCreation as boolean) ?? false,
    getAiDefaultModel: () => ''
  };
}

test('FolderService: board.praxis.json overrides the connection project identity', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    await writeBoardConfigFile(dir, { projectKey: 'FOLDER', projectName: 'Folder Board', allowIssueCreation: true });

    const service = new FolderService(stubConfig(dir));
    const projects = await service.getProjects();
    assert.equal(projects[0]?.key, 'FOLDER');
    assert.equal(projects[0]?.name, 'Folder Board');

    const check = await service.checkConnection();
    assert.equal(check.status, 'ok');
    assert.match(check.message, /issue creation enabled/);

    service.dispose();
  });
});

test('FolderService: falls back to connection settings when no board.praxis.json', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new FolderService(stubConfig(dir));
    const projects = await service.getProjects();
    assert.equal(projects[0]?.key, 'CONN');
    assert.equal(projects[0]?.name, 'Connection Board');
    service.dispose();
  });
});

test('FolderService.syncBoardConfigToFolder writes identity only by default', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new FolderService(
      stubConfig(dir, { projectKey: 'WEB', projectName: 'Web App', allowIssueCreation: true })
    );
    await service.syncBoardConfigToFolder();

    // No allowIssueCreation — it is an app-wide toggle on this path, not per-board.
    assert.deepEqual(await readBoardConfigFile(dir), { projectKey: 'WEB', projectName: 'Web App' });
    const projects = await service.getProjects();
    assert.equal(projects[0]?.key, 'WEB');
    assert.equal(projects[0]?.name, 'Web App');
    service.dispose();
  });
});

test('FolderService.syncBoardConfigToFolder includes allowIssueCreation when asked', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new FolderService(
      stubConfig(dir, { projectKey: 'WEB', projectName: 'Web App', allowIssueCreation: true })
    );
    await service.syncBoardConfigToFolder({ includeAllowIssueCreation: true });
    assert.deepEqual(await readBoardConfigFile(dir), {
      projectKey: 'WEB',
      projectName: 'Web App',
      allowIssueCreation: true
    });
    service.dispose();
  });
});

test('FolderService: a secondary root names its board from its own board.praxis.json', async () => {
  await withTempDir(async parent => {
    // Two nested plans roots, each an empty features/ dir.
    const rootA = path.join(parent, 'repo-a');
    const rootB = path.join(parent, 'repo-b');
    await fs.mkdir(path.join(rootA, 'features'), { recursive: true });
    await fs.mkdir(path.join(rootB, 'features'), { recursive: true });
    await writeBoardConfigFile(rootB, { projectName: 'Repo B Nice Name' });

    const service = new FolderService(stubConfig(parent));
    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    // The primary board plus one per discovered secondary root.
    assert.ok(boards.length >= 2, `expected >= 2 boards, got ${boards.length}`);
    assert.ok(
      boards.some(board => board.name.includes('Repo B Nice Name')),
      `no board named from repo-b's config: ${boards.map(b => b.name).join(', ')}`
    );
    service.dispose();
  });
});

test('FolderService: a secondary root uses its own projectKey, not the connection default', async () => {
  await withTempDir(async parent => {
    const rootA = path.join(parent, 'repo-a');
    const rootB = path.join(parent, 'repo-b');
    await fs.mkdir(path.join(rootA, 'features'), { recursive: true });
    await fs.mkdir(path.join(rootB, 'features'), { recursive: true });
    await writeBoardConfigFile(rootB, { projectKey: 'BEE', projectName: 'Repo B' });

    const service = new FolderService(stubConfig(parent));
    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    const repoB = boards.find(board => board.locationName === rootB);
    assert.ok(repoB, `no board for repo-b: ${boards.map(b => b.locationName).join(', ')}`);
    assert.equal(repoB.projectKey, 'BEE');
    // The board id is derived from that root's own key, not the connection's.
    assert.ok(repoB.id.startsWith('folder-bee-'), `unexpected board id ${repoB.id}`);
    // Sibling roots without their own config keep the connection default.
    assert.ok(boards.some(board => board.projectKey === 'CONN'));
    service.dispose();
  });
});

test('FolderService: several configured roots each contribute their boards', async () => {
  await withTempDir(async parent => {
    // Two roots that share no parent — what a curated multi-folder connection is.
    const first = path.join(parent, 'one');
    const second = path.join(parent, 'two');
    await fs.mkdir(path.join(first, 'features'), { recursive: true });
    await fs.mkdir(path.join(second, 'features'), { recursive: true });
    await writeBoardConfigFile(second, { projectKey: 'TWO', projectName: 'Second' });

    const service = new FolderService({
      ...stubConfig(first),
      getFolderRoots: () => [first, second]
    });
    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    assert.ok(boards.some(board => board.locationName === first), 'first root missing');
    assert.ok(boards.some(board => board.locationName === second), 'second root missing');
    assert.ok(boards.some(board => board.projectKey === 'TWO'), 'second root key missing');
    service.dispose();
  });
});

test('FolderService.syncBoardConfigToFolder rejects (and writes nothing) for an unreadable folder', async () => {
  await withTempDir(async dir => {
    const missing = path.join(dir, 'nope');
    const service = new FolderService(stubConfig(missing));
    await assert.rejects(() => service.syncBoardConfigToFolder());
    await assert.rejects(() => fs.access(path.join(missing, BOARD_CONFIG_FILENAME)));
    service.dispose();
  });
});

// ── Declared workflow (FX-BE-045) ───────────────────────────────────

const SOFTWARE_WORKFLOW = [
  { id: 's1', name: 'Backlog', category: 'todo' as const },
  { id: 's2', name: 'Requirements', category: 'todo' as const },
  { id: 's3', name: 'Architecture', category: 'indeterminate' as const },
  { id: 's4', name: 'Implementation', category: 'indeterminate' as const },
  { id: 's5', name: 'Verification', category: 'indeterminate' as const },
  { id: 's6', name: 'Done', category: 'done' as const }
];

/** A plans tree with one feature whose status names an arbitrary stage. */
async function writePlans(dir: string, featureStatus: string): Promise<void> {
  const featureDir = path.join(dir, 'features', 'feature-01-demo');
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(
    path.join(featureDir, 'feature.md'),
    ['# Demo Feature', '', `**Status:** ${featureStatus}`, '**Type:** Feature', ''].join('\n'),
    'utf8'
  );
}

test('a workflow round-trips through board.praxis.json', async () => {
  await withTempDir(async dir => {
    await writeBoardConfigFile(dir, { projectKey: 'APP', workflow: SOFTWARE_WORKFLOW });
    const read = await readBoardConfigFile(dir);
    assert.deepEqual(read.workflow?.map(stage => stage.name), [
      'Backlog', 'Requirements', 'Architecture', 'Implementation', 'Verification', 'Done'
    ]);
    assert.equal(read.workflow?.[2].category, 'indeterminate');
  });
});

test('a malformed or invalid workflow is ignored rather than breaking the board', async () => {
  await withTempDir(async dir => {
    for (const workflow of [
      'not an array',
      [],
      [{ name: 'Only one' }],                                   // fewer than two stages
      [{ name: 'A' }, { name: 'a' }],                           // duplicate names
      [{ name: 'Doing', category: 'indeterminate' }, { name: 'Done', category: 'done' }] // no todo
    ]) {
      await fs.writeFile(
        path.join(dir, BOARD_CONFIG_FILENAME),
        JSON.stringify({ projectKey: 'APP', workflow }),
        'utf8'
      );
      const read = await readBoardConfigFile(dir);
      assert.equal(read.workflow, undefined, JSON.stringify(workflow));
      assert.equal(read.projectKey, 'APP', 'the rest of the file still loads');
    }
  });
});

test('FolderService with no declared workflow renders the five statuses folders have always had', async () => {
  await withTempDir(async dir => {
    await writePlans(dir, '🚧 In progress');
    const service = new FolderService(stubConfig(dir));
    const filters = { projectKeys: [], types: [], searchText: '' };
    const [board] = await service.getBoards(filters);
    const details = await service.getBoardDetails(board);
    assert.deepEqual(details.columnStatusOrder, [
      'Backlog', 'To Do', 'In Progress', 'Blocked', 'Done'
    ]);
    assert.equal(details.issues[0].status, 'In Progress');
    await service.dispose();
  });
});

test('FolderService renders the workflow the folder declares, and a doc lands in a named stage', async () => {
  await withTempDir(async dir => {
    await writePlans(dir, 'Architecture');
    await writeBoardConfigFile(dir, { projectKey: 'APP', workflow: SOFTWARE_WORKFLOW });

    const service = new FolderService(stubConfig(dir));
    const filters = { projectKeys: [], types: [], searchText: '' };
    const [board] = await service.getBoards(filters);
    const details = await service.getBoardDetails(board);

    assert.deepEqual(details.columnStatusOrder, [
      'Backlog', 'Requirements', 'Architecture', 'Implementation', 'Verification', 'Done'
    ]);
    assert.equal(details.issues[0].status, 'Architecture');
    assert.deepEqual(
      details.columns.find(column => column.name === 'Architecture')?.issues.map(i => i.summary),
      ['Demo Feature']
    );
    // Transitions offered are the declared workflow's other stages.
    const transitions = await service.getTransitions(details.issues[0].key);
    assert.deepEqual(transitions.map(t => t.toStatus), [
      'Backlog', 'Requirements', 'Implementation', 'Verification', 'Done'
    ]);
    await service.dispose();
  });
});

test('a freeform status resolves onto a declared workflow through its categories', async () => {
  await withTempDir(async dir => {
    await writePlans(dir, '✅ Complete');
    await writeBoardConfigFile(dir, { projectKey: 'APP', workflow: SOFTWARE_WORKFLOW });
    const service = new FolderService(stubConfig(dir));
    const filters = { projectKeys: [], types: [], searchText: '' };
    const [board] = await service.getBoards(filters);
    const details = await service.getBoardDetails(board);
    // No exact "Complete" stage — resolves via category to this workflow's done.
    assert.equal(details.issues[0].status, 'Done');
    await service.dispose();
  });
});
