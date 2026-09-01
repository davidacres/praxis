import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  PROJECT_WORKFLOWS_DIR,
  WorkflowPolicyStore,
  WorkflowStore,
  loadProjectWorkflows,
  resolveWorkflowCatalog
} from './workflowStore';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowPolicyProfile } from './workflowTypes';
import type { KeyValueStore } from '../host/stateStore';

/** The smallest definition that passes validation: one agent stage, no gates. */
function minimal(id: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: id,
    scope: 'global',
    version: 1,
    entryNodeId: 'only',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    nodes: [
      {
        type: 'agent-task',
        id: 'only',
        name: 'Only',
        x: 0,
        y: 0,
        inputs: [],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Do the work.',
        outputs: [],
        mutatesWorktree: true
      }
    ],
    edges: [],
    ...overrides
  };
}

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

// ── Precedence ───────────────────────────────────────────────────────────

test('project beats global beats built-in for the same workflow id', () => {
  const catalog = resolveWorkflowCatalog({
    builtIn: [minimal('delivery')],
    global: [minimal('delivery')],
    project: [{ definition: minimal('delivery', { scope: 'project', projectId: 'p1' }), source: 'project', path: '/p/.praxis/workflows/delivery.json' }]
  });
  assert.equal(catalog.workflows.length, 1);
  assert.equal(catalog.workflows[0].source, 'project');
});

test('shadowing is reported rather than applied silently', () => {
  const catalog = resolveWorkflowCatalog({
    builtIn: [minimal('delivery')],
    global: [minimal('delivery')],
    project: [{ definition: minimal('delivery', { scope: 'project', projectId: 'p1' }), source: 'project', path: '/p/x.json' }]
  });
  assert.equal(catalog.shadowed.length, 1);
  assert.equal(catalog.shadowed[0].workflowId, 'delivery');
  assert.equal(catalog.shadowed[0].effective, 'project');
  assert.deepEqual(
    catalog.shadowed[0].shadowed.map(entry => entry.source),
    ['global', 'built-in']
  );
});

test('workflows with distinct ids never report shadowing', () => {
  const catalog = resolveWorkflowCatalog({ builtIn: [minimal('a')], global: [minimal('b')] });
  assert.equal(catalog.workflows.length, 2);
  assert.deepEqual(catalog.shadowed, []);
});

// ── Conflicts and scope ──────────────────────────────────────────────────

test('a duplicate id inside one source is a conflict, not a precedence question', () => {
  const catalog = resolveWorkflowCatalog({ global: [minimal('delivery'), minimal('delivery')] });
  assert.equal(catalog.workflows.length, 1);
  assert.equal(catalog.invalid.length, 1);
  assert.match(catalog.invalid[0].issues[0].message, /Duplicate workflow id/);
  assert.deepEqual(catalog.shadowed, []);
});

test('a project-scoped definition found in global storage is rejected', () => {
  const catalog = resolveWorkflowCatalog({ global: [minimal('delivery', { scope: 'project', projectId: 'p1' })] });
  assert.equal(catalog.workflows.length, 0);
  assert.ok(catalog.invalid[0].issues.some(issue => issue.path === 'scope'));
});

test('a global-scoped definition committed under a project is rejected', () => {
  const catalog = resolveWorkflowCatalog({
    project: [{ definition: minimal('delivery'), source: 'project', path: '/p/x.json' }]
  });
  assert.equal(catalog.workflows.length, 0);
  assert.equal(catalog.invalid[0].path, '/p/x.json');
  assert.ok(catalog.invalid[0].issues.some(issue => issue.path === 'scope'));
});

test('an invalid definition is reported, never silently dropped', () => {
  const broken = minimal('broken');
  broken.entryNodeId = 'nope';
  const catalog = resolveWorkflowCatalog({ global: [broken] });
  assert.equal(catalog.workflows.length, 0);
  assert.equal(catalog.invalid.length, 1);
  assert.equal(catalog.invalid[0].workflowId, 'broken');
});

// ── Project folder discovery ─────────────────────────────────────────────

test('a project with no .praxis/workflows folder loads cleanly', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'praxis-wf-'));
  const result = await loadProjectWorkflows(folder);
  assert.deepEqual(result.workflows, []);
  assert.deepEqual(result.invalid, []);
});

test('committed project workflows are discovered and tagged with their path', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'praxis-wf-'));
  const dir = path.join(folder, PROJECT_WORKFLOWS_DIR);
  await mkdir(dir, { recursive: true });
  const definition = minimal('delivery', { scope: 'project', projectId: 'p1' });
  await writeFile(path.join(dir, 'delivery.json'), JSON.stringify(definition), 'utf8');

  const result = await loadProjectWorkflows(folder);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].definition.id, 'delivery');
  assert.equal(result.workflows[0].source, 'project');
  assert.ok(result.workflows[0].path?.endsWith('delivery.json'));
});

test('a malformed committed workflow is reported so the project sees it is ignored', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'praxis-wf-'));
  const dir = path.join(folder, PROJECT_WORKFLOWS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');

  const result = await loadProjectWorkflows(folder);
  assert.deepEqual(result.workflows, []);
  assert.equal(result.invalid.length, 1);
  assert.ok(result.invalid[0].path?.endsWith('broken.json'));
});

test('a workflow from a newer schema is reported, not loaded', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'praxis-wf-'));
  const dir = path.join(folder, PROJECT_WORKFLOWS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'future.json'),
    JSON.stringify({ ...minimal('future'), schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 }),
    'utf8'
  );

  const result = await loadProjectWorkflows(folder);
  assert.deepEqual(result.workflows, []);
  assert.equal(result.invalid[0].issues[0].path, 'schemaVersion');
});

// ── Global store ─────────────────────────────────────────────────────────

test('saving an invalid workflow is refused while the author can still fix it', async () => {
  const store = new WorkflowStore(memoryStore());
  await assert.rejects(() => store.save(minimal('broken', { entryNodeId: 'nope' })), /is invalid/);
});

test('the global store refuses a project-scoped workflow', async () => {
  const store = new WorkflowStore(memoryStore());
  await assert.rejects(
    () => store.save(minimal('delivery', { scope: 'project', projectId: 'p1' })),
    /belongs in .praxis\/workflows/
  );
});

test('re-saving a workflow bumps its version so in-flight runs keep theirs', async () => {
  const store = new WorkflowStore(memoryStore());
  const first = await store.save(minimal('delivery'));
  assert.equal(first.version, 1);
  const second = await store.save(minimal('delivery'));
  assert.equal(second.version, 2);
  assert.equal(store.list().length, 1);
});

test('removing an unknown workflow is an error, not a silent no-op', async () => {
  const store = new WorkflowStore(memoryStore());
  await assert.rejects(() => store.remove('ghost'), /was not found/);
});

// ── Policy store ─────────────────────────────────────────────────────────

function policy(id: string, overrides: Partial<WorkflowPolicyProfile> = {}): WorkflowPolicyProfile {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: id,
    scope: 'global',
    requiredGates: ['review'],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 3,
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...overrides
  };
}

test('a project policy replaces the global one rather than merging with it', async () => {
  const store = new WorkflowPolicyStore(memoryStore());
  await store.save(policy('global-default'));
  await store.save(policy('p1-strict', { scope: 'project', projectId: 'p1', requiredGates: ['security'] }));

  assert.equal(store.forProject('p1')?.id, 'p1-strict');
  assert.deepEqual(store.forProject('p1')?.requiredGates, ['security']);
  // A project with no profile of its own still falls back to global.
  assert.equal(store.forProject('p2')?.id, 'global-default');
});

test('a project with no policy anywhere resolves to undefined rather than a guess', () => {
  assert.equal(new WorkflowPolicyStore(memoryStore()).forProject('p1'), undefined);
});

test('a project policy without projectId is refused', async () => {
  const store = new WorkflowPolicyStore(memoryStore());
  await assert.rejects(() => store.save(policy('bad', { scope: 'project' })), /requires projectId/);
});

test('a global policy carrying projectId is refused', async () => {
  const store = new WorkflowPolicyStore(memoryStore());
  await assert.rejects(() => store.save(policy('bad', { projectId: 'p1' })), /must not carry projectId/);
});

test('an attempt cap below one is refused', async () => {
  const store = new WorkflowPolicyStore(memoryStore());
  await assert.rejects(() => store.save(policy('bad', { maxAttemptsPerNode: 0 })), /1 or greater/);
});
