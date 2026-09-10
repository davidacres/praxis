import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMobileCommandLedger,
  MOBILE_PROTOCOL_VERSION,
  type MobileAccessPolicy,
  type MobileCaller,
  type MobileHostApplication,
  type MobileReadRequest,
} from '@praxis/core';
import { RecordAssembler, SecureChannel, generateKeyPair } from '@praxis/mobile-protocol';
import * as net from 'node:net';
import { MobileLanServer } from './mobileLanServer';

const caller: MobileCaller = { deviceId: 'phone-1', subject: 'dave', capabilities: ['view', 'execute'] };

function fixtureApp(): MobileHostApplication {
  return {
    reads: {
      'projects.snapshot': async () => ({ projectId: 'p1', name: 'Praxis' }),
    },
    commands: {
      'sessions.continue': async () => ({ ok: true }),
      'workflowRuns.start': async () => ({ runId: 'r1' }),
      'workflowRuns.cancel': async () => ({ ok: true }),
      'workflowRuns.retryStage': async () => ({ ok: true }),
      'permissions.respond': async () => ({ ok: true }),
      'workflowGates.approve': async () => ({ ok: true }),
    },
    ledger: new InMemoryMobileCommandLedger(),
    payloadDigest: () => 'digest',
  };
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** Minimal client: pin the host key, run the IK handshake, send one framed read, await one framed reply. */
function callRead(port: number, hostPublicKey: Uint8Array): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const channel = SecureChannel.initiator({ staticKeyPair: generateKeyPair(), remoteStaticPublicKey: hostPublicKey });
    const assembler = new RecordAssembler();
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(channel.nextHandshakeMessage());
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out'));
    }, 2000);
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('socket hang up'));
    });
    socket.on('data', (chunk: Buffer) => {
      for (const record of assembler.push(chunk)) {
        if (!channel.open) {
          channel.readHandshakeMessage(record);
          if (channel.open) {
            const request: MobileReadRequest = {
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              requestId: 'r-1',
              caller,
              target: { hostId: 'host', projectId: 'p1' },
              operation: 'projects.snapshot',
            };
            socket.write(channel.encrypt(encode({ id: 'f-1', kind: 'read', payload: request })));
          }
          continue;
        }
        const reply = JSON.parse(new TextDecoder().decode(channel.decrypt(record))) as { ok: boolean; value?: unknown; error?: string };
        clearTimeout(timer);
        resolve(reply);
        socket.destroy();
      }
    });
  });
}

test('serves an encrypted read once the peer completes the IK handshake', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey });
  const policy: MobileAccessPolicy = { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] };
  await server.start(0, policy);
  try {
    const reply = await callRead(server.port!, hostKey.publicKey);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.value, { projectId: 'p1', name: 'Praxis' });
  } finally {
    await server.stop();
  }
});

test('a peer that pins the wrong host key never gets served', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    await assert.rejects(callRead(server.port!, generateKeyPair().publicKey), /timed out|ECONNRESET|socket hang up/);
  } finally {
    await server.stop();
  }
});

test('an out-of-range subnet allowlist refuses a loopback peer', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: ['10.0.0.'] });
  try {
    await assert.rejects(callRead(server.port!, hostKey.publicKey), /timed out|ECONNRESET|socket hang up/);
  } finally {
    await server.stop();
  }
});

test('stop() closes the listener and drops connections', async () => {
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: generateKeyPair() });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  assert.equal(server.listening, true);
  await server.stop();
  assert.equal(server.listening, false);
  assert.equal(server.connectionCount(), 0);
});

test('applyPolicy(dropConnections) severs established peers', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const channel = SecureChannel.initiator({ staticKeyPair: generateKeyPair(), remoteStaticPublicKey: hostKey.publicKey });
    const assembler = new RecordAssembler();
    const socket = net.createConnection({ host: '127.0.0.1', port: server.port! }, () => socket.write(channel.nextHandshakeMessage()));
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        for (const record of assembler.push(chunk)) {
          if (!channel.open) channel.readHandshakeMessage(record);
        }
        if (channel.open) resolve();
      });
      socket.setTimeout(3000, () => reject(new Error('timed out')));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.connectionCount(), 1);
    server.applyPolicy({ mode: 'off', allowedInterfaces: [], allowedSubnets: [] }, true);
    assert.equal(server.connectionCount(), 0);
    socket.destroy();
  } finally {
    await server.stop();
  }
});
