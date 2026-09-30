/**
 * Phone ↔ relay ↔ desktop: a real `RelayServer`, the desktop's outbound
 * `MobileRelayClient`, the production `MobileLanServer` (serving the relayed
 * stream), and the same `MobileSecureClient` the phone uses, connected through
 * a WebSocket. Nothing here is inbound to the desktop.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  InMemoryMobileCommandLedger,
  MOBILE_PROTOCOL_VERSION,
  type MobileAccessPolicy,
  type MobileCaller,
  type MobileHostApplication,
  type MobileReadRequest,
} from '@praxis/core';
import { MobileConnectionError, MobileSecureClient, generateKeyPair, type KeyPair } from '@praxis/mobile-protocol';
import { RelayServer, channelIdForKey } from '@praxis/mobile-relay';
import WebSocket, { WebSocketServer } from 'ws';
import { MobileLanServer } from './mobileLanServer';
import { MobileRelayClient, type MobileRelayIdentity } from './mobileRelayClient';

const caller: MobileCaller = { deviceId: 'phone-1', capabilities: ['view'] };
const internet: MobileAccessPolicy = { mode: 'internet', allowedInterfaces: [], allowedSubnets: [] };

function fixtureApp(): MobileHostApplication {
  return {
    reads: { 'projects.snapshot': async () => ({ projects: [{ projectId: 'p1', name: 'Praxis' }] }) },
    commands: {},
    ledger: new InMemoryMobileCommandLedger(),
    payloadDigest: () => 'digest',
  } as unknown as MobileHostApplication;
}

function relayIdentity(): MobileRelayIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKeyHex: der.subarray(der.length - 32).toString('hex'), privateKey };
}

const snapshotRead = (): MobileReadRequest => ({
  protocolVersion: MOBILE_PROTOCOL_VERSION,
  requestId: 'r-1',
  caller,
  target: { hostId: 'host' },
  operation: 'projects.snapshot',
});

function phone(url: string, channel: string, hostKey: KeyPair, phoneKey = generateKeyPair()): MobileSecureClient {
  return new MobileSecureClient({
    connect: handlers => {
      const ws = new WebSocket(`${url}/v1/connect?channel=${channel}`);
      ws.on('open', () => handlers.onConnect());
      ws.on('message', data => handlers.onData(new Uint8Array(data as Buffer)));
      ws.on('error', error => handlers.onError(error));
      ws.on('close', () => handlers.onClose());
      return { write: bytes => ws.send(bytes), destroy: () => ws.terminate() };
    },
    endpoint: 'relay',
    staticKeyPair: phoneKey,
    remoteStaticPublicKey: hostKey.publicKey,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
  });
}

interface Rig {
  relay: RelayServer;
  url: string;
  hostKey: KeyPair;
  lan: MobileLanServer;
  desktop: MobileRelayClient;
  channel: string;
}

async function withRig(
  body: (rig: Rig) => Promise<void>,
  options: { policy?: MobileAccessPolicy; authorizePeer?: () => { deviceId: string; capabilities: readonly ['view'] } | undefined } = {},
): Promise<void> {
  const relay = new RelayServer({ port: 0, host: '127.0.0.1' });
  await relay.start();
  const url = `ws://127.0.0.1:${relay.port}`;
  const hostKey = generateKeyPair();
  const lan = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey, ...(options.authorizePeer ? { authorizePeer: options.authorizePeer } : {}) });
  lan.applyPolicy(options.policy ?? internet, false);
  const identity = relayIdentity();
  const desktop = new MobileRelayClient({ relayUrl: url, identity, onStream: stream => lan.acceptRelayedStream(stream), minBackoffMs: 20, maxBackoffMs: 50 });
  desktop.start();
  const started = Date.now();
  while (desktop.state !== 'registered') {
    if (Date.now() - started > 2_000) throw new Error(`relay client did not register (${desktop.state}: ${desktop.error})`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try {
    await body({ relay, url, hostKey, lan, desktop, channel: desktop.channel! });
  } finally {
    desktop.stop();
    await lan.stop();
    await relay.stop();
  }
}

test('a phone reads from the desktop through the relay, with no inbound path to the desktop', async () => {
  await withRig(async ({ url, hostKey, channel, desktop, lan }) => {
    assert.equal(lan.listening, false, 'the desktop has no listening socket');
    assert.equal(channel, channelIdForKey(desktop['options'].identity.publicKeyHex));
    const client = phone(url, channel, hostKey);
    await client.connect();
    const value = await client.read<{ projects: Array<{ projectId: string }> }>(snapshotRead());
    assert.deepEqual(value.projects.map(project => project.projectId), ['p1']);
    client.close();
  });
});

test('a phone pinned to a different host key fails the handshake', async () => {
  await withRig(async ({ url, channel }) => {
    const client = phone(url, channel, generateKeyPair());
    await assert.rejects(client.connect(), (error: unknown) => error instanceof MobileConnectionError);
  });
});

test('local-only mode refuses a relayed peer', async () => {
  await withRig(async ({ url, hostKey, channel }) => {
    const client = phone(url, channel, hostKey);
    await assert.rejects(client.connect(), (error: unknown) => error instanceof MobileConnectionError && error.code === 'access-denied');
  }, { policy: { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] } });
});

test('off refuses a relayed peer', async () => {
  await withRig(async ({ url, hostKey, channel }) => {
    const client = phone(url, channel, hostKey);
    await assert.rejects(client.connect(), (error: unknown) => error instanceof MobileConnectionError && error.code === 'access-disabled');
  }, { policy: { mode: 'off', allowedInterfaces: [], allowedSubnets: [] } });
});

test('stopping the relay client closes established phones', async () => {
  await withRig(async ({ url, hostKey, channel, desktop }) => {
    const client = phone(url, channel, hostKey);
    await client.connect();
    const closed = new Promise<void>(resolve => client.onClose(() => resolve()));
    desktop.stop();
    await closed;
  });
});

test('revoking a device drops its relayed connection', async () => {
  await withRig(async ({ url, hostKey, channel, lan }) => {
    const client = phone(url, channel, hostKey);
    await client.connect();
    const closed = new Promise<void>(resolve => client.onClose(() => resolve()));
    assert.equal(lan.dropDevice('paired-phone'), 1);
    await closed;
  }, { authorizePeer: () => ({ deviceId: 'paired-phone', capabilities: ['view'] }) });
});

test('the desktop re-registers after the relay restarts', async () => {
  const relay = new RelayServer({ port: 0, host: '127.0.0.1' });
  await relay.start();
  const port = relay.port!;
  const identity = relayIdentity();
  const desktop = new MobileRelayClient({ relayUrl: `ws://127.0.0.1:${port}`, identity, onStream: () => undefined, minBackoffMs: 20, maxBackoffMs: 50 });
  desktop.start();
  const until = async (state: string): Promise<void> => {
    const started = Date.now();
    while (desktop.state !== state) {
      if (Date.now() - started > 3_000) throw new Error(`still ${desktop.state}, wanted ${state}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await until('registered');
    await relay.stop();
    await until('error');
    const again = new RelayServer({ port, host: '127.0.0.1' });
    await again.start();
    try {
      await until('registered');
      assert.equal(again.channelCount(), 1);
    } finally {
      await again.stop();
    }
  } finally {
    desktop.stop();
  }
});

test('everything the relay forwards is ciphertext', async () => {
  await withRig(async ({ url, hostKey, channel }) => {
    // A recording hop on the phone's leg: it sees exactly what the relay operator sees.
    const seen: Buffer[] = [];
    const hop = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    hop.on('connection', (down, req) => {
      const up = new WebSocket(`${url}${req.url}`);
      const queued: Buffer[] = [];
      up.on('open', () => queued.splice(0).forEach(chunk => up.send(chunk)));
      down.on('message', data => {
        const chunk = data as Buffer;
        seen.push(chunk);
        if (up.readyState === up.OPEN) up.send(chunk);
        else queued.push(chunk);
      });
      up.on('message', data => {
        seen.push(data as Buffer);
        down.send(data as Buffer);
      });
      down.on('close', () => up.close());
      up.on('close', () => down.close());
    });
    await new Promise<void>(resolve => hop.once('listening', () => resolve()));
    try {
      const client = phone(`ws://127.0.0.1:${(hop.address() as { port: number }).port}`, channel, hostKey);
      await client.connect();
      const value = await client.read<{ projects: unknown[] }>(snapshotRead());
      assert.equal(value.projects.length, 1, 'the read really round-tripped');
      client.close();
    } finally {
      hop.close();
    }
    const wire = Buffer.concat(seen);
    const leaks = (bytes: Buffer): boolean => ['Praxis', 'projectId', 'projects.snapshot', 'phone-1'].some(marker => bytes.includes(marker));
    assert.ok(wire.length > 100, 'the recording captured the exchange');
    assert.equal(leaks(wire), false, 'the relay saw plaintext');
    // The detector is not vacuous: the same markers in a plaintext exchange are found.
    assert.equal(leaks(Buffer.from(JSON.stringify({ projects: [{ projectId: 'p1', name: 'Praxis' }] }))), true);
  });
});
