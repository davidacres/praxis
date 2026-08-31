import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KeyValueStore } from '../host/stateStore';
import { ProjectStore, validateProjectRecord } from './projectStore';
import { createProjectService } from './projectService';
import type { ProjectRecord, ProjectStorage } from './projectTypes';

const EMPTY_FILTERS = { projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all' as const, grouping: 'none' as const };

/** In-memory `KeyValueStore` — the same port the Electron adapter implements. */
function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T,>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}

function projectRecord(overrides: Partial<ProjectRecord> & { storage?: ProjectStorage }): ProjectRecord {
  return {
    id: 'p1',
    name: 'Demo Project',
    key: 'DEMO',
    type: 'software',
    purpose: '',
    brief: {},
    workflowStages: [{ id: 's1', name: 'Backlog' }, { id: 's2', name: 'Done' }],
    defaultBoardId: 'project-board-p1',
    workItems: [],
    linkedBoards: [],
    defaultAiToolMode: 'project-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

async function withPlansFolder(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-projsvc-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('createProjectService: an app-storage project serves its own work items', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({
    workItems: [{
      id: 'i1', key: 'DEMO-1', summary: 'From app storage', description: '',
      issueType: 'Task', status: 'Backlog',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
  }));

  const service = createProjectService(store, 'p1');
  assert.equal(service.mode, 'project');
  const page = await service.getIssues(EMPTY_FILTERS, 0, 50);
  assert.equal(page.total, 1);
  assert.equal(page.issues[0].summary, 'From app storage');
  service.dispose();
});

test('createProjectService: a folder-backed project reads the markdown plans tree', async () => {
  await withPlansFolder(async dir => {
    const featureDir = path.join(dir, 'features', 'feature-01-first-feature');
    await fs.mkdir(featureDir, { recursive: true });
    await fs.writeFile(
      path.join(featureDir, 'feature-01-first-feature.md'),
      '**Type:** Feature\n**Status:** Backlog\n\n# First Feature\n',
      'utf8'
    );

    const store = new ProjectStore(memoryStore());
    // `workItems` stays empty: a folder-backed project must not read it.
    await store.create(projectRecord({ storage: 'folder', workspaceFolder: dir, workItems: [] }));

    const service = createProjectService(store, 'p1');
    assert.equal(service.mode, 'project');

    const page = await service.getIssues(EMPTY_FILTERS, 0, 50);
    assert.ok((page.total ?? 0) > 0, 'expected the folder feature to surface as an issue');
    assert.ok(
      page.issues.some(issue => issue.summary === 'First Feature'),
      `feature not found: ${page.issues.map(i => i.summary).join(', ')}`
    );
    // Issue keys use the project's key, not the folder default.
    assert.ok(page.issues.every(issue => issue.projectKey === 'DEMO'));

    // The board keeps the *project's* identity even though the folder service
    // backs its contents — otherwise navigation would lose the board.
    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    assert.equal(boards.length, 1);
    assert.equal(boards[0].id, 'project-board-p1');
    assert.equal(boards[0].connectionId, 'project:p1');
    assert.equal(boards[0].type, 'project');

    const details = await service.getBoardDetails(boards[0]);
    assert.equal(details.board.id, 'project-board-p1');
    assert.ok(details.issues.length > 0);
    service.dispose();
  });
});

test('a folder-backed project without a workspace folder fails validation', () => {
  // `defaultAiToolMode: 'project-only'` and a non-software type clear the other
  // folderless rules, so the storage rule is what this asserts.
  assert.throws(
    () => validateProjectRecord(projectRecord({
      storage: 'folder',
      workspaceFolder: undefined,
      type: 'research'
    })),
    /folder-backed project requires a workspace folder/i
  );
});
