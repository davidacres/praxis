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
import { LiveFolderService, type LiveFolderConfigProvider } from './liveFolderService';

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

function stubConfig(dir: string, overrides: Partial<Record<string, unknown>> = {}): LiveFolderConfigProvider {
  return {
    getDefaultPageSize: () => 25,
    getLiveFolderPath: () => dir,
    getLiveFolderProjectKey: () => (overrides.projectKey as string) ?? 'CONN',
    getLiveFolderProjectName: () => (overrides.projectName as string) ?? 'Connection Board',
    getLiveFolderAllowIssueCreation: () => (overrides.allowIssueCreation as boolean) ?? false,
    getAiDefaultModel: () => ''
  };
}

test('LiveFolderService: board.praxis.json overrides the connection project identity', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    await writeBoardConfigFile(dir, { projectKey: 'FOLDER', projectName: 'Folder Board', allowIssueCreation: true });

    const service = new LiveFolderService(stubConfig(dir));
    const projects = await service.getProjects();
    assert.equal(projects[0]?.key, 'FOLDER');
    assert.equal(projects[0]?.name, 'Folder Board');

    const check = await service.checkConnection();
    assert.equal(check.status, 'ok');
    assert.match(check.message, /issue creation enabled/);

    service.dispose();
  });
});

test('LiveFolderService: falls back to connection settings when no board.praxis.json', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new LiveFolderService(stubConfig(dir));
    const projects = await service.getProjects();
    assert.equal(projects[0]?.key, 'CONN');
    assert.equal(projects[0]?.name, 'Connection Board');
    service.dispose();
  });
});

test('LiveFolderService.syncBoardConfigToFolder writes identity only by default', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new LiveFolderService(
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

test('LiveFolderService.syncBoardConfigToFolder includes allowIssueCreation when asked', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, 'features'));
    const service = new LiveFolderService(
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

test('LiveFolderService: a secondary root names its board from its own board.praxis.json', async () => {
  await withTempDir(async parent => {
    // Two nested plans roots, each an empty features/ dir.
    const rootA = path.join(parent, 'repo-a');
    const rootB = path.join(parent, 'repo-b');
    await fs.mkdir(path.join(rootA, 'features'), { recursive: true });
    await fs.mkdir(path.join(rootB, 'features'), { recursive: true });
    await writeBoardConfigFile(rootB, { projectName: 'Repo B Nice Name' });

    const service = new LiveFolderService(stubConfig(parent));
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

test('LiveFolderService.syncBoardConfigToFolder rejects (and writes nothing) for an unreadable folder', async () => {
  await withTempDir(async dir => {
    const missing = path.join(dir, 'nope');
    const service = new LiveFolderService(stubConfig(missing));
    await assert.rejects(() => service.syncBoardConfigToFolder());
    await assert.rejects(() => fs.access(path.join(missing, BOARD_CONFIG_FILENAME)));
    service.dispose();
  });
});
