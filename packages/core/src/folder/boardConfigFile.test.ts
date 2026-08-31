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
