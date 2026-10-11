import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProjectWorkflow, WORKFLOW_SCHEMA_VERSION, type KeyValueStore, type WorkflowDefinition } from '@praxis/core';
import { projectWorkflowTrust } from './workflowProjectTrust';

test('committed workflow trust is local, survives store reload, and covers the exact executed commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-trust-'));
  const values = new Map<string, unknown>();
  const store: KeyValueStore = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
  const definition: WorkflowDefinition = { schemaVersion: WORKFLOW_SCHEMA_VERSION, id: 'security-check', name: 'Security check', scope: 'project', projectId: 'p1', version: 1, entryNodeId: 'check', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', edges: [], nodes: [{ id: 'check', name: 'Check', type: 'check', x: 0, y: 0, inputs: [], outputs: [], command: process.execPath, args: ['-e', 'console.log("safe")'] }] };
  try {
    assert.equal((await projectWorkflowTrust(store, root, definition.id)).trusted, true, 'no repository definition requires no grant');
    await writeProjectWorkflow(root, definition);
    const state = await projectWorkflowTrust(store, root, definition.id);
    assert.equal(state.trusted, false);
    assert.match(state.commands[0], /safe/);
    await store.update(state.key, state.fingerprint);
    assert.equal((await projectWorkflowTrust(store, root, definition.id)).trusted, true);
    assert.equal((await projectWorkflowTrust(store, root, definition.id, { ...definition, name: 'Security check — run title' }, true)).trusted, true);
    const changed = structuredClone(definition);
    (changed.nodes[0] as { args: string[] }).args = ['-e', 'console.log("changed")'];
    assert.equal((await projectWorkflowTrust(store, root, definition.id, changed)).trusted, false, 'an effective draft cannot borrow trust from a different committed command');
    await writeProjectWorkflow(root, changed);
    assert.equal((await projectWorkflowTrust(store, root, definition.id)).trusted, false);
    await rm(join(root, '.praxis', 'workflows', 'security-check.json'));
    assert.equal((await projectWorkflowTrust(store, root, definition.id, changed, true)).trusted, false, 'removing a committed file cannot authorize an unreviewed persisted snapshot');
    assert.equal((await projectWorkflowTrust(store, root, definition.id, definition, true)).trusted, true, 'a reviewed snapshot remains trusted after a branch switch');
    if (process.platform !== 'win32') {
      await symlink(root, root + '-alias');
      assert.equal((await projectWorkflowTrust(store, root + '-alias', definition.id, definition, true)).key, state.key);
      await rm(root + '-alias');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
