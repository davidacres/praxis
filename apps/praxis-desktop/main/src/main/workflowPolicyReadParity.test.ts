import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowPolicyStore, type WorkflowPolicyProfile } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';
import { DEFAULT_MIGRATED_CHANNELS } from './rustHostInstance';

const key = 'praxis.workflowPolicies.v1';

// Exercise the existing policy-store contract over a real host, without enabling production
// routing. Rust reads the durable file; TS still owns all writes and its cache.
test('opt-in workflow policy read preserves the TypeScript listing contract without writes', async t => {
  const sparse = { id: '', requiredGates: [null, 'future-gate'], futureField: { retained: true } };
  const valid = { schemaVersion: 1, id: 'global', name: 'Global', scope: 'global',
    requiredGates: ['tests'], requireHumanApproval: true, allowGateBypass: false,
    requireTrustedAgents: true, maxAttemptsPerNode: 3,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const fixtures: Array<[string, string | undefined]> = [
    ['missing store', undefined], ['malformed JSON', '{ broken'],
    ['missing key', JSON.stringify({ unrelated: true })],
    ['non-array key', JSON.stringify({ [key]: {} })],
    ['records and unknown fields', JSON.stringify({ [key]: [valid, null, {}, { id: 1, requiredGates: [] }, sparse] })],
    ['null root rejects', 'null']
  ];
  assert.ok(!DEFAULT_MIGRATED_CHANNELS.includes('workflows:listPolicies'), 'cutover remains gated');
  for (const [label, text] of fixtures) await t.test(label, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-policy-parity-'));
    const file = path.join(dir, 'workflows.json');
    if (text !== undefined) fs.writeFileSync(file, text);
    const bridge = new RustHostBridge({ transport: new StdioRustHostTransport({ userDataDir: dir, settingsPath: path.join(dir, 'settings.json') }) });
    try {
      const store = new WorkflowPolicyStore(new JsonKeyValueStore(file));
      if (text === 'null') {
        let expected: Error | undefined;
        try { store.list(); } catch (error) { expected = error as Error; }
        assert.ok(expected);
        await assert.rejects(() => bridge.invoke('workflows:listPolicies'), error => (error as Error).message === expected.message);
      } else {
        assert.deepEqual(await bridge.invoke('workflows:listPolicies'), store.list());
      }
      assert.equal(fs.existsSync(file), text !== undefined);
      if (text !== undefined) assert.equal(fs.readFileSync(file, 'utf8'), text, 'read must preserve the complete store bytes');
    } finally { await bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test('opt-in workflow read sees acknowledged TypeScript policy saves and removals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-policy-save-parity-'));
  const file = path.join(dir, 'workflows.json');
  const store = new WorkflowPolicyStore(new JsonKeyValueStore(file));
  const bridge = new RustHostBridge({ transport: new StdioRustHostTransport({ userDataDir: dir, settingsPath: path.join(dir, 'settings.json') }) });
  const profile: WorkflowPolicyProfile = { schemaVersion: 1, id: 'p1', name: 'Global', scope: 'global',
    requiredGates: [], requireHumanApproval: true, allowGateBypass: false, requireTrustedAgents: false,
    maxAttemptsPerNode: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  try {
    assert.deepEqual(await bridge.invoke('workflows:listPolicies'), []);
    await store.save(profile);
    assert.deepEqual(await bridge.invoke('workflows:listPolicies'), store.list());
    await store.remove(profile.id);
    assert.deepEqual(await bridge.invoke('workflows:listPolicies'), []);
  } finally { await bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
