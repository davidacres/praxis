import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { InMemoryMobileCommandLedger, type MobileHostApplication, type MobileReadRequest, type RustRpcRequest } from '@praxis/core';
import { generateKeyPair, mobileConnectionStatus, MobileSecureClient } from '@praxis/mobile-protocol';
import { RelayServer, channelIdForKey } from '@praxis/mobile-relay';
import WebSocket from 'ws';
import { RustMobileTransport } from './rustMobileTransport';
import { selectMobileTransport } from './mobileTransport';
import type { RustHostCallHandler } from './rustHostBridge';

const policy = { mode: 'internet' as const, allowedInterfaces: [], allowedSubnets: [] };
const read: MobileReadRequest = { protocolVersion: 1, requestId: 'r1', operation: 'projects.snapshot', caller: { deviceId: 'forged', capabilities: ['view', 'execute'] }, target: { hostId: 'h' } };

function fixtureApp(): MobileHostApplication {
  return {
    reads: { 'projects.snapshot': async request => ({ projects: [{ projectId: 'p1' }, { projectId: 'p2' }], caller: request.caller }) },
    commands: { 'sessions.create': async command => ({ caller: command.caller }) } as MobileHostApplication['commands'],
    ledger: new InMemoryMobileCommandLedger(),
    payloadDigest: () => 'unused-on-rust-path',
  };
}

function stub() {
  const calls: RustRpcRequest[] = [];
  let onCall!: RustHostCallHandler;
  let fail = false;
  let hang = false;
  let disposed = false;
  const app = fixtureApp();
  const adapter = new RustMobileTransport({ app, hostStaticKey: generateKeyPair(), authorizePeer: () => undefined }, {
    host: { userDataDir: '/unused', settingsPath: '/unused/settings.json' },
    interfaces: () => [{ interfaceName: 'lo0', address: '127.0.0.1' }],
    requestTimeoutMs: 50,
    createTransport: options => {
      onCall = options.onCall!;
      return {
        dispatch: async request => {
          calls.push(request);
          if (fail) throw new Error('host died');
          if (hang) return new Promise(() => undefined);
          return { id: request.id, ok: true, result: { listening: request.channel !== 'mobile:stop', port: 43210, addresses: ['127.0.0.1'], connectionCount: 2 } };
        },
        onEvent: () => () => undefined,
        dispose: () => { disposed = true; },
      };
    },
  });
  return { adapter, app, calls, call: (method: string, params: unknown) => onCall(method, params), fail: () => { fail = true; }, hang: () => { hang = true; }, disposed: () => disposed };
}

test('mobile runtime selection is opt-in, source-only and respects the global Rust disable switch', () => {
  assert.equal(selectMobileTransport(false, {}), 'typescript');
  assert.equal(selectMobileTransport(false, { PRAXIS_MOBILE_TRANSPORT: 'rust' }), 'rust');
  assert.equal(selectMobileTransport(true, { PRAXIS_MOBILE_TRANSPORT: 'rust' }), 'typescript');
  for (const disabled of ['none', 'false', '0', 'off']) {
    assert.equal(selectMobileTransport(false, { PRAXIS_MOBILE_TRANSPORT: 'rust', PRAXIS_RUST_CHANNELS: disabled }), 'typescript');
  }
});

test('adapter maps controls, seeds retained events and stops polling on disposal', async () => {
  const rig = stub();
  try {
    rig.app.ledger.appendEvent({ protocolVersion: 1, sequence: 7, eventId: 'e7', emittedAt: new Date().toISOString(), target: { hostId: 'h' }, event: {} });
    await rig.adapter.start(0, policy);
    assert.equal(rig.calls[0].channel, 'mobile:appendEvent');
    assert.equal(rig.adapter.port, 43210);
    assert.equal(rig.adapter.connectionCount(), 2);
    const start = rig.calls.find(call => call.channel === 'mobile:start')!;
    assert.deepEqual((start.args![0] as { addresses: unknown }).addresses, [{ interfaceName: 'lo0', address: '127.0.0.1' }]);
    await rig.adapter.applyPolicy(policy, true);
    await rig.adapter.dropDevice('phone');
    await rig.adapter.dropPublicKey('key');
    await rig.adapter.promotePending('key', { deviceId: 'phone', capabilities: ['view'] });
    await rig.adapter.dropAll(mobileConnectionStatus('host-key-reset'));
    assert.deepEqual(rig.calls.at(-1)?.args, [{ status: mobileConnectionStatus('host-key-reset') }]);
    await rig.adapter.stop();
    assert.equal(rig.adapter.listening, false);
  } finally { await rig.adapter.dispose(); }
  assert.equal(rig.disposed(), true);
  await assert.rejects(rig.adapter.start(0, policy), /disposed/);
});

test('callbacks keep TypeScript capability checks, use no second command ledger and refuse unknown calls', async () => {
  const rig = stub();
  try {
    assert.equal(await rig.call('mobile.authorizePeer', { publicKey: 'unknown' }), null);
    assert.deepEqual(await rig.call('mobile.unpairedPeer', { publicKey: 'unknown', tokenId: null }), mobileConnectionStatus('access-denied'));
    await assert.rejects(rig.call('mobile.read', { ...read, caller: { deviceId: 'phone', capabilities: [] } }), /not authorised/);
    const command = { protocolVersion: 1, operation: 'sessions.create', caller: { deviceId: 'phone', capabilities: ['execute'] }, target: { hostId: 'h', projectId: 'p1' }, commandId: 'c1', issuedAt: new Date().toISOString(), payload: {} };
    assert.deepEqual(await rig.call('mobile.command', command), { caller: command.caller });
    assert.equal(rig.app.ledger.get('c1'), undefined);
    await assert.rejects(rig.call('mobile.command', { ...command, caller: { deviceId: 'phone', capabilities: ['view'] } }), /not authorised/);
    await assert.rejects(rig.call('other', {}), /Unknown mobile host call/);
  } finally { await rig.adapter.dispose(); }
});

test('a dead Rust process cannot be silently restarted with an empty replay ledger', async () => {
  const rig = stub();
  try {
    await rig.adapter.start(0, policy);
    rig.fail();
    await assert.rejects(rig.adapter.dropDevice('phone'), /host died/);
    const count = rig.calls.length;
    await assert.rejects(rig.adapter.start(0, policy), /host died/);
    assert.equal(rig.calls.length, count);
    assert.equal(rig.adapter.listening, false);
    assert.match(rig.adapter.bindError!, /host died/);
  } finally { await rig.adapter.dispose(); }
});

test('a control timeout closes the host and prevents a silent retry', async () => {
  const rig = stub();
  try {
    await rig.adapter.start(0, policy);
    rig.hang();
    await assert.rejects(rig.adapter.dropDevice('phone'), /control timed out/);
    assert.equal(rig.disposed(), true);
    const count = rig.calls.length;
    await assert.rejects(rig.adapter.start(0, policy), /control timed out/);
    assert.equal(rig.calls.length, count);
  } finally { await rig.adapter.dispose(); }
});

test('real Rust bridge serves the TypeScript app over relay, then revokes the phone', { skip: process.env.PRAXIS_TEST_RUST_MOBILE !== '1', timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-relay-adapter-'));
  const relay = new RelayServer({ port: 0, host: '127.0.0.1' });
  const key = generateKeyPair();
  const app = fixtureApp();
  let commands = 0;
  app.commands['sessions.create'] = async command => { commands++; return { caller: command.caller }; };
  const adapter = new RustMobileTransport({ app, hostStaticKey: key, authorizePeer: () => ({ deviceId: 'paired', capabilities: ['view', 'execute'], projectIds: ['p1'] }) }, {
    host: { userDataDir: dir, settingsPath: path.join(dir, 'settings.json') },
    interfaces: () => [{ interfaceName: 'lo0', address: '127.0.0.1' }],
  });
  t.after(async () => { await adapter.dispose(); await relay.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await relay.start();
  await adapter.start(0, policy);
  const url = `ws://127.0.0.1:${relay.port}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyHex = der.subarray(der.length - 32).toString('hex');
  const client = adapter.createRelay({ relayUrl: url, identity: { privateKey, publicKeyHex } });
  await client.start();
  await waitFor(() => client.state === 'registered');
  assert.equal(client.channel, channelIdForKey(publicKeyHex));
  const phone = new MobileSecureClient({
    connect: handlers => {
      const ws = new WebSocket(`${url}/v1/connect?channel=${client.channel}`);
      ws.on('open', () => handlers.onConnect());
      ws.on('message', data => handlers.onData(new Uint8Array(data as Buffer)));
      ws.on('error', error => handlers.onError(error));
      ws.on('close', () => handlers.onClose());
      return { write: bytes => ws.send(bytes), destroy: () => ws.terminate() };
    },
    endpoint: url, staticKeyPair: generateKeyPair(), remoteStaticPublicKey: key.publicKey,
    connectTimeoutMs: 3000, requestTimeoutMs: 3000,
  });
  t.after(() => phone.close());
  await phone.connect();
  const value = await phone.read<{ projects: unknown[]; caller: { deviceId: string } }>(read);
  assert.deepEqual(value.projects, [{ projectId: 'p1' }]);
  assert.equal(value.caller.deviceId, 'paired');
  await assert.rejects(phone.read({ ...read, target: { hostId: 'h', projectId: 'p2' } }), /not authorised/);
  const command = { protocolVersion: 1 as const, operation: 'sessions.create' as const, caller: read.caller, target: { hostId: 'h', projectId: 'p1' }, commandId: 'relay-c1', issuedAt: new Date().toISOString(), payload: {} };
  const outcome = await phone.command(command);
  assert.deepEqual(await phone.command(command), outcome);
  assert.equal(commands, 1);
  assert.equal(await adapter.dropDevice('paired'), 1);
  await waitFor(() => phone.status?.code === 'device-revoked');
  await client.stop();
  assert.equal(client.state, 'stopped');
  assert.equal(client.channel, undefined);
});

test('real Rust bridge promotes a pending phone and preserves the key-reset refusal', { skip: process.env.PRAXIS_TEST_RUST_MOBILE !== '1', timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-pair-adapter-'));
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const tokens: Array<string | undefined> = [];
  const adapter = new RustMobileTransport({ app: fixtureApp(), hostStaticKey: hostKey,
    onUnpairedPeer: (_key, token) => { tokens.push(token); return mobileConnectionStatus(token ? 'pairing-pending' : 'pairing-required'); },
  }, { host: { userDataDir: dir, settingsPath: path.join(dir, 'settings.json') }, interfaces: () => [{ interfaceName: 'lo0', address: '127.0.0.1' }] });
  t.after(async () => { await adapter.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  await adapter.start(0, policy);
  const phone = new MobileSecureClient({
    connect: handlers => {
      const socket = net.createConnection({ host: '127.0.0.1', port: adapter.port! }, () => handlers.onConnect());
      socket.on('data', (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
      socket.on('error', error => handlers.onError(error));
      socket.on('close', () => handlers.onClose());
      return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
    }, endpoint: 'loopback', staticKeyPair: phoneKey, remoteStaticPublicKey: hostKey.publicKey,
    pairingTokenId: 'invite', connectTimeoutMs: 3000, requestTimeoutMs: 3000,
  });
  t.after(() => phone.close());
  const connected = phone.connect();
  await waitFor(() => tokens.includes('invite'));
  assert.equal(tokens[0], undefined);
  await adapter.promotePending(Buffer.from(phoneKey.publicKey).toString('hex'), { deviceId: 'promoted', capabilities: ['view'], projectIds: ['p1'] });
  await connected;
  const result = await phone.read<{ caller: { deviceId: string } }>(read);
  assert.equal(result.caller.deviceId, 'promoted');
  await adapter.dropAll(mobileConnectionStatus('host-key-reset'));
  await waitFor(() => phone.status?.code === 'host-key-reset');
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transport state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
