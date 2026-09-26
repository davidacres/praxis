import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../host/stateStore';
import { ProjectStore, validateProjectRecord } from './projectStore';
import { createProjectService } from './projectService';
import { buildProjectConnection } from './projectConnection';
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
  assert.equal(service.mode, 'app');
  const page = await service.getIssues(EMPTY_FILTERS, 0, 50);
  assert.equal(page.total, 1);
  assert.equal(page.issues[0].summary, 'From app storage');
  service.dispose();
});

test('createProjectService: a Story can be created under a Feature and the board reads both directions', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');

  const feature = await service.createIssue({ projectKey: 'DEMO', issueType: 'Feature', summary: 'Onboarding' });
  const story = await service.createIssue({
    projectKey: 'DEMO', issueType: 'Story', summary: 'Sign-up form', parentKey: feature.key
  });

  assert.equal(story.parentKey, feature.key);
  assert.equal(story.parentIssue?.summary, 'Onboarding');

  const details = await service.getBoardDetails({ id: 'project-board-p1' } as never);
  const reloadedStory = details.issues.find(issue => issue.key === story.key);
  assert.equal(reloadedStory?.parentKey, feature.key);
  service.dispose();
});

test('createProjectService: a Feature cannot itself have a parent', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');
  const feature = await service.createIssue({ projectKey: 'DEMO', issueType: 'Feature', summary: 'A' });

  await assert.rejects(
    service.createIssue({ projectKey: 'DEMO', issueType: 'Feature', summary: 'B', parentKey: feature.key }),
    /cannot have a parent/i
  );
  service.dispose();
});

test('createProjectService: a Story can only take a Feature as its parent, not another Story', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');
  const story = await service.createIssue({ projectKey: 'DEMO', issueType: 'Story', summary: 'A' });

  await assert.rejects(
    service.createIssue({ projectKey: 'DEMO', issueType: 'Task', summary: 'B', parentKey: story.key }),
    /can only belong to/i
  );
  service.dispose();
});

test('createProjectService: an unknown parent key is rejected', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');

  await assert.rejects(
    service.createIssue({ projectKey: 'DEMO', issueType: 'Story', summary: 'A', parentKey: 'DEMO-999' }),
    /was not found/i
  );
  service.dispose();
});

test('createProjectService: updateIssue can attach and later clear a parent', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');
  const feature = await service.createIssue({ projectKey: 'DEMO', issueType: 'Feature', summary: 'A' });
  const story = await service.createIssue({ projectKey: 'DEMO', issueType: 'Story', summary: 'B' });
  assert.equal(story.parentKey, undefined);

  const attached = await service.updateIssue(story.key, { parentKey: feature.key });
  assert.equal(attached.parentKey, feature.key);

  const cleared = await service.updateIssue(story.key, { parentKey: null });
  assert.equal(cleared.parentKey, undefined);
  service.dispose();
});

test('createProjectService: getParentItems for a Story only returns Features, not Bugs', async () => {
  const store = new ProjectStore(memoryStore());
  await store.create(projectRecord({ workItems: [] }));
  const service = createProjectService(store, 'p1');
  await service.createIssue({ projectKey: 'DEMO', issueType: 'Feature', summary: 'A feature' });
  await service.createIssue({ projectKey: 'DEMO', issueType: 'Bug', summary: 'A bug' });

  const candidates = await service.getParentItems(EMPTY_FILTERS, undefined, { childIssueType: 'Story' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].issueType, 'Feature');
  service.dispose();
});

test('folder-backed projects use a normal folder connection', () => {
  const connection = buildProjectConnection(projectRecord({
    storage: 'folder',
    workspaceFolder: '/tmp/plans',
    workItems: []
  }));

  assert.equal(connection.mode, 'folder');
  assert.equal(connection.id, 'project:p1');
  assert.deepEqual(connection.settings.roots, ['/tmp/plans']);
  assert.equal(connection.settings.projectKey, 'DEMO');
});

test('app-owned projects use a normal local connection', () => {
  const connection = buildProjectConnection(projectRecord({ storage: 'app' }));
  assert.equal(connection.mode, 'app');
  assert.equal(connection.settings.projectId, 'p1');
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
