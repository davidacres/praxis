import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ScheduledRunStore, armScheduledRun, type IssueSummary, type ScheduledRunRequestStatus } from '@praxis/core';
import { importScheduledRunRequests, type ScheduledRunRequestDeps } from './scheduledRunRequests';
import { defaultScheduleWorkflow } from './scheduledWorkflow';

const NOW = '2026-10-26T12:00:00.000Z';

function issue(key: string, planningId: string, dependsOn: string[] = []): IssueSummary {
  return { key, planningId, summary: `${planningId}: Work`, status: 'To Do', statusCategory: 'To Do', issueType: 'Task', projectKey: 'PRX', ...(dependsOn.length ? { dependsOn } : {}) };
}

async function fixture(projects: Array<{ id: string; workspaceFolder?: string }> | ((folder: string) => Array<{ id: string; workspaceFolder?: string }>) = folder => [{ id: 'p1', workspaceFolder: folder }]) {
  const folder = await mkdtemp(path.join(tmpdir(), 'praxis-sched-request-'));
  const dir = path.join(folder, '.praxis', 'scheduled-runs');
  await mkdir(dir, { recursive: true });
  const data = new Map<string, unknown>();
  const store = new ScheduledRunStore({ get: <T>(key: string) => data.get(key) as T | undefined, update: async (key, value) => { data.set(key, value); } });
  const changed: string[] = [];
  const deps: ScheduledRunRequestDeps = {
    projects: () => (typeof projects === 'function' ? projects(folder) : projects),
    issues: async () => [issue('PRX-1', 'TASK-1'), issue('PRX-2', 'TASK-2', ['PRX-1'])],
    workflowChoices: async () => [{ workflowId: 'full-sdlc', name: 'Full SDLC', trigger: 'ticket' }, { workflowId: 'governed-delivery', name: 'Governed', trigger: 'on-demand' }],
    defaultWorkflow: defaultScheduleWorkflow,
    store: () => store,
    changed: id => changed.push(id),
    now: () => NOW
  };
  const write = (name: string, body: Record<string, unknown>) => writeFile(path.join(dir, name), JSON.stringify({
    schemaVersion: 1, kind: 'praxis.scheduledRunRequest', name: 'Night run', date: '2026-11-01', time: '22:00', timezone: 'Europe/London', tickets: ['TASK-1', 'TASK-2'], ...body
  }));
  const status = async (name: string) => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as ScheduledRunRequestStatus;
  return { folder, dir, store, deps, changed, write, status, cleanup: () => rm(folder, { recursive: true, force: true }) };
}

test('a request file becomes an ordered, unarmed draft with a status file', async () => {
  const f = await fixture();
  try {
    await f.write('night.json', {});
    const outcomes = await importScheduledRunRequests(f.deps);
    assert.equal(outcomes.length, 1);
    const status = await f.status('night.status.json');
    assert.equal(status.state, 'imported', status.errors.join('\n'));
    assert.equal(status.workflowId, 'full-sdlc');
    assert.deepEqual(status.entries?.map(entry => entry.issueKey), ['PRX-1', 'PRX-2']);
    const run = f.store.get(status.runId!);
    assert.equal(run?.status, 'draft');
    assert.deepEqual(run?.entries.map(entry => entry.ticket), [
      { connectionId: 'project:p1', issueKey: 'PRX-1', title: 'TASK-1: Work' },
      { connectionId: 'project:p1', issueKey: 'PRX-2', title: 'TASK-2: Work' }
    ]);
    assert.deepEqual(f.changed, ['p1']);

    // Unchanged files are not read again, even after the draft is deleted in the app.
    await f.store.remove(status.runId!);
    assert.equal((await importScheduledRunRequests(f.deps)).length, 0);
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('editing the request updates the same draft and keeps entry ids', async () => {
  const f = await fixture();
  try {
    await f.write('night.json', { tickets: ['TASK-1'], satisfiedDependencies: [] });
    await importScheduledRunRequests(f.deps);
    const first = f.store.list()[0];
    await f.write('night.json', { name: 'Renamed', workflowId: 'governed-delivery' });
    await importScheduledRunRequests(f.deps);
    const runs = f.store.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, first.id);
    assert.equal(runs[0].name, 'Renamed');
    assert.equal(runs[0].policy.workflowId, 'governed-delivery');
    assert.equal(runs[0].entries[0].id, first.entries[0].id);
    assert.equal(runs[0].entries.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('invalid requests are rejected with reasons and save nothing', async () => {
  const f = await fixture();
  try {
    await f.write('bad-order.json', { tickets: ['TASK-2', 'TASK-1'] });
    await f.write('bad-workflow.json', { workflowId: 'nope' });
    await writeFile(path.join(f.dir, 'broken.json'), '{ not json');
    await importScheduledRunRequests(f.deps);
    assert.match((await f.status('bad-order.status.json')).errors.join(' '), /listed before its dependency/);
    assert.match((await f.status('bad-workflow.status.json')).errors.join(' '), /Workflow "nope" is not available/);
    assert.equal((await f.status('broken.status.json')).state, 'rejected');
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a draft that has been armed is never changed by its request', async () => {
  const f = await fixture();
  try {
    await f.write('night.json', {});
    await importScheduledRunRequests(f.deps);
    const run = f.store.list()[0];
    await f.store.save(armScheduledRun(run, NOW));
    await f.write('night.json', { name: 'Sneaky edit' });
    await importScheduledRunRequests(f.deps);
    const status = await f.status('night.status.json');
    assert.equal(status.state, 'rejected');
    assert.match(status.errors[0], /now scheduled/);
    assert.equal(f.store.get(run.id)?.name, 'Night run');
    assert.equal(f.store.get(run.id)?.status, 'scheduled');
  } finally {
    await f.cleanup();
  }
});

test('a shared folder needs an explicit project id', async () => {
  const f = await fixture(folder => [{ id: 'p1', workspaceFolder: folder }, { id: 'p2', workspaceFolder: folder }]);
  try {
    await f.write('night.json', {});
    await importScheduledRunRequests(f.deps);
    assert.match((await f.status('night.status.json')).errors[0], /Several projects use this folder/);
    await f.write('night.json', { projectId: 'p2' });
    await importScheduledRunRequests(f.deps);
    const status = await f.status('night.status.json');
    assert.equal(status.state, 'imported');
    assert.equal(f.store.get(status.runId!)?.projectId, 'p2');
  } finally {
    await f.cleanup();
  }
});
