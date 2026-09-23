import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRuntimeManager } from './manager';
import { mirrorBundledAgents } from './bundledAgents';

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

test('a pin runs a built-in agent on its own runtime with the built-in’s instructions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'praxis-pins-'));
  await mirrorBundledAgents(root);
  const pin = (id: string, command: string, replaces: string) =>
    seedAgent(root, id, { schemaVersion: 1, id, name: id === 'codex-implementer' ? 'Codex Implementer' : 'Claude Implementer', type: 'acp', entry: { command }, replaces });
  await pin('claude-implementer', 'claude-agent-acp', 'praxis-implementer');
  await pin('codex-implementer', 'codex-acp', 'praxis-implementer');
  await pin('orphan-pin', 'codex-acp', 'no-such-agent');
  const manager = new AgentRuntimeManager({ userAgentsPath: root, profileRoots: [root], trustedProfileRoots: [root], includeBundled: true });
  const snapshot = await manager.refresh();

  const host = snapshot.runtimeHosts?.find(candidate => candidate.manifest.id === 'praxis-implementer');
  assert.equal(host?.pinnedBy?.id, 'claude-implementer', 'first pin by id runs the built-in');
  assert.equal(host?.pinnedBy?.name, 'Claude Implementer');
  assert.deepEqual(host?.manifest.entry, { command: 'claude-agent-acp' });
  assert.equal(host?.manifest.replaces, undefined);

  const profile = snapshot.profiles?.find(entry => entry.profile.id === 'praxis-implementer');
  assert.match(profile?.profile.instructions ?? '', /Praxis Implementer/, 'the built-in keeps its own instructions');
  assert.equal(profile?.builtIn, true);

  const ids = new Set([...(snapshot.runtimeHosts ?? []).map(entry => entry.manifest.id), ...(snapshot.profiles ?? []).map(entry => entry.profile.id)]);
  assert.equal(ids.has('claude-implementer'), false, 'a pin is not an agent of its own');
  assert.equal(ids.has('codex-implementer'), false);
  assert.equal(ids.has('orphan-pin'), true, 'a pin for an unknown agent stays visible so it can be removed');
  const planner = snapshot.runtimeHosts?.find(candidate => candidate.manifest.id === 'praxis-planner');
  assert.equal(planner?.pinnedBy, undefined);
});
