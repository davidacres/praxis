import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRuntimeManager } from './manager';

async function seedAgent(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent.json'), JSON.stringify(manifest));
}

async function makeManager(): Promise<{ manager: AgentRuntimeManager; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'praxis-runtime-'));
  return { manager: new AgentRuntimeManager({ userAgentsPath: root }), root };
}

test('start records a running host with a pid; stop clears it; restart re-runs', async t => {
  const { manager, root } = await makeManager();
  await seedAgent(root, 'keepalive', {
    schemaVersion: 1,
    id: 'keepalive',
    name: 'Keepalive',
    type: 'acp',
    entry: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e9)'] }
  });
  t.after(() => manager.dispose());

  let snap = await manager.start('keepalive');
  assert.equal(snap.hosts['keepalive']?.state, 'running');
  assert.ok(typeof snap.hosts['keepalive']?.pid === 'number');
  assert.ok('keepalive' in snap.capabilities);

  snap = await manager.stop('keepalive');
  assert.equal(snap.hosts['keepalive'], undefined);
  assert.equal('keepalive' in snap.capabilities, false);

  snap = await manager.restart('keepalive');
  assert.equal(snap.hosts['keepalive']?.state, 'running');
});

test('a host that fails to spawn is recorded failed and start rejects', async t => {
  const { manager, root } = await makeManager();
  await seedAgent(root, 'broken', {
    schemaVersion: 1,
    id: 'broken',
    name: 'Broken',
    type: 'acp',
    entry: { command: '/definitely/not/a/real/binary-xyz', args: [] }
  });
  t.after(() => manager.dispose());

  await assert.rejects(() => manager.start('broken'));
  const snap = await manager.list();
  assert.equal(snap.hosts['broken']?.state, 'failed');
  assert.ok(snap.hosts['broken']?.error);
});

test('discovery alone never starts a host', async t => {
  const { manager, root } = await makeManager();
  await seedAgent(root, 'idle', {
    schemaVersion: 1,
    id: 'idle',
    name: 'Idle',
    type: 'acp',
    entry: { command: process.execPath, args: ['-e', ''] }
  });
  t.after(() => manager.dispose());

  const snap = await manager.refresh();
  assert.deepEqual(snap.hosts, {});
  assert.deepEqual(snap.capabilities, {});
});
