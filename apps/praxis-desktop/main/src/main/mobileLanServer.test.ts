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
import {
  MobileConnectionError,
  MobileSecureClient,
  RecordAssembler,
  SecureChannel,
  generateKeyPair,
  mobileConnectionStatus,
  type KeyPair,
  type MobileSocketConnector,
} from '@praxis/mobile-protocol';
import * as net from 'node:net';
import { MobileLanServer } from './mobileLanServer';

const caller: MobileCaller = { deviceId: 'phone-1', subject: 'dave', capabilities: ['view', 'execute'] };

function fixtureApp(onRead?: (request: MobileReadRequest) => void): MobileHostApplication {
  return {
    reads: {
      'projects.snapshot': async request => {
        onRead?.(request);
        return request.target.projectId
          ? { projectId: request.target.projectId, name: 'Praxis' }
          : { projects: [{ projectId: 'p1', name: 'Praxis' }, { projectId: 'p2', name: 'Other' }] };
      },
    },
    commands: {
      'sessions.create': async () => ({ ok: true }),
      'sessions.continue': async () => ({ ok: true }),
      'sessions.cancel': async () => ({ ok: true }),
      'sessions.configure': async () => ({ ok: true }),
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
function callRead(port: number, hostPublicKey: Uint8Array, pairingCode?: string, targetProjectId: string | null = 'p1'): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const channel = SecureChannel.initiator({
      staticKeyPair: generateKeyPair(),
      remoteStaticPublicKey: hostPublicKey,
      ...(pairingCode ? { prologue: new TextEncoder().encode(pairingCode) } : {}),
    });
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
              target: { hostId: 'host', ...(targetProjectId ? { projectId: targetProjectId } : {}) },
              operation: 'projects.snapshot',
            };
            socket.write(channel.encrypt(encode({ id: 'f-1', kind: 'read', payload: request })));
          }
          continue;
        }
        const reply = JSON.parse(new TextDecoder().decode(channel.decrypt(record))) as { kind: string; ok: boolean; value?: unknown; error?: string };
        if (reply.kind === 'status') continue;
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

test('filters project discovery to the authenticated device grant', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({
    app: fixtureApp(),
    hostStaticKey: hostKey,
    authorizePeer: () => ({ deviceId: 'paired-phone', capabilities: ['view'], projectIds: ['p1'] }),
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const reply = await callRead(server.port!, hostKey.publicKey, undefined, null);
    assert.deepEqual(reply.value, { projects: [{ projectId: 'p1', name: 'Praxis' }] });
  } finally {
    await server.stop();
  }
});

test('binds requests to the Noise-authenticated device instead of trusting caller claims', async () => {
  const hostKey = generateKeyPair();
  let observed: MobileReadRequest | undefined;
  const server = new MobileLanServer({ app: fixtureApp(request => { observed = request; }), hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const reply = await callRead(server.port!, hostKey.publicKey);
    assert.equal(reply.ok, true);
    assert.notEqual(observed?.caller.deviceId, caller.deviceId);
    assert.match(observed?.caller.deviceId ?? '', /^device:/);
    assert.deepEqual(observed?.caller.capabilities, ['view', 'execute', 'approve']);
  } finally {
    await server.stop();
  }
});

test('requires the out-of-band pairing code when the listener configures one', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({ app: fixtureApp(), hostStaticKey: hostKey, pairingCode: 'pair-me' });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    await assert.rejects(callRead(server.port!, hostKey.publicKey, 'wrong-code'), /timed out|ECONNRESET|socket hang up/);
    const reply = await callRead(server.port!, hostKey.publicKey, 'pair-me');
    assert.equal(reply.ok, true);
  } finally {
    await server.stop();
  }
});

test('pushes newly appended session events without waiting for another phone request', async () => {
  const hostKey = generateKeyPair();
  const app = fixtureApp();
  const server = new MobileLanServer({ app, hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const event = await new Promise<{ kind: string; envelope?: { sequence: number } }>((resolve, reject) => {
      const channel = SecureChannel.initiator({ staticKeyPair: generateKeyPair(), remoteStaticPublicKey: hostKey.publicKey });
      const assembler = new RecordAssembler();
      const socket = net.createConnection({ host: '127.0.0.1', port: server.port! }, () => socket.write(channel.nextHandshakeMessage()));
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, 2000);
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        for (const record of assembler.push(chunk)) {
          if (!channel.open) {
            channel.readHandshakeMessage(record);
            if (channel.open) {
              const request: MobileReadRequest = {
                protocolVersion: MOBILE_PROTOCOL_VERSION,
                requestId: 'stream-read',
                caller,
                target: { hostId: 'host', projectId: 'p1' },
                operation: 'projects.snapshot',
              };
              socket.write(channel.encrypt(encode({ id: 'stream-frame', kind: 'read', payload: request })));
            }
            continue;
          }
          const frame = JSON.parse(new TextDecoder().decode(channel.decrypt(record))) as { kind: string; envelope?: { sequence: number } };
          if (frame.kind === 'reply') {
            app.ledger.appendEvent({
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              eventId: 'session-event-1',
              sequence: 1,
              emittedAt: new Date().toISOString(),
              target: { hostId: 'host', projectId: 'p1', sessionId: 's1' },
              event: { type: 'session.snapshot' },
            });
          } else if (frame.kind === 'event') {
            clearTimeout(timer);
            socket.destroy();
            resolve(frame);
          }
        }
      });
    });
    assert.equal(event.envelope?.sequence, 1);
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

function nodeConnector(port: number): MobileSocketConnector {
  return handlers => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
    socket.on('data', (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
    socket.on('error', error => handlers.onError(error));
    socket.on('close', () => handlers.onClose());
    return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
  };
}

function phoneClient(port: number, hostKey: KeyPair, phoneKey: KeyPair = generateKeyPair(), pairingTokenId?: string): MobileSecureClient {
  return new MobileSecureClient({
    connect: nodeConnector(port),
    endpoint: `127.0.0.1:${port}`,
    staticKeyPair: phoneKey,
    remoteStaticPublicKey: hostKey.publicKey,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    ...(pairingTokenId ? { pairingTokenId } : {}),
  });
}

const readProject = { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: 'r-live', caller, target: { hostId: 'host', projectId: 'p1' }, operation: 'projects.snapshot' as const };

test('an unpaired phone presents its invitation token and stays pending until the desktop confirms', async () => {
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const publicKeyHex = Buffer.from(phoneKey.publicKey).toString('hex');
  const presented: Array<string | undefined> = [];
  let trusted = false;
  const granted = { deviceId: 'phone-live', capabilities: ['view'] as const, projectIds: ['p1'] };
  const server = new MobileLanServer({
    app: fixtureApp(),
    hostStaticKey: hostKey,
    authorizePeer: hex => trusted && hex === publicKeyHex ? granted : undefined,
    onUnpairedPeer: (_hex, tokenId) => {
      presented.push(tokenId);
      if (tokenId === undefined) return mobileConnectionStatus('pairing-required');
      return tokenId === 'invite-1' ? mobileConnectionStatus('pairing-pending') : mobileConnectionStatus('invitation-invalid');
    },
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const wrong = phoneClient(server.port!, hostKey, generateKeyPair(), 'stolen-guess');
    await assert.rejects(wrong.connect(), (error: unknown) => error instanceof MobileConnectionError && error.code === 'invitation-invalid');

    const phone = phoneClient(server.port!, hostKey, phoneKey, 'invite-1');
    const statuses: string[] = [];
    const connected = new Promise<void>((resolve, reject) => {
      phone.onStatus(status => {
        statuses.push(status.code);
        if (status.code === 'pairing-pending') {
          // The desktop confirms well after the phone started waiting.
          setTimeout(() => {
            trusted = true;
            server.promotePending(publicKeyHex, granted);
          }, 100);
        }
      });
      phone.connect().then(resolve, reject);
    });
    await connected;
    assert.deepEqual(statuses, ['pairing-required', 'pairing-pending', 'ready']);
    assert.deepEqual(presented, [undefined, 'stolen-guess', undefined, 'invite-1']);
    assert.deepEqual(await phone.read(readProject), { projectId: 'p1', name: 'Praxis' });
    phone.close();

    // Reconnecting as the now-paired device goes straight to ready.
    const again = phoneClient(server.port!, hostKey, phoneKey);
    await again.connect();
    assert.deepEqual(await again.read(readProject), { projectId: 'p1', name: 'Praxis' });
    again.close();
  } finally {
    await server.stop();
  }
});

test('refusals reach the phone as reasons, not a bare closed socket', async () => {
  const hostKey = generateKeyPair();
  const server = new MobileLanServer({
    app: fixtureApp(),
    hostStaticKey: hostKey,
    authorizePeer: () => undefined,
    onUnpairedPeer: () => mobileConnectionStatus('device-revoked'),
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    await assert.rejects(phoneClient(server.port!, hostKey).connect(), (error: unknown) =>
      error instanceof MobileConnectionError && error.code === 'device-revoked' && /revoked/.test(error.message));
    server.applyPolicy({ mode: 'local-only', allowedInterfaces: [], allowedSubnets: ['10.0.0.'] }, false);
    await assert.rejects(phoneClient(server.port!, hostKey).connect(), (error: unknown) =>
      error instanceof MobileConnectionError && error.code === 'access-denied' && /allowed interfaces and subnets/.test(error.message));
  } finally {
    await server.stop();
  }
});

test('revocation, key reset and listener shutdown tell a connected phone why it was dropped', async () => {
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const publicKeyHex = Buffer.from(phoneKey.publicKey).toString('hex');
  const server = new MobileLanServer({
    app: fixtureApp(),
    hostStaticKey: hostKey,
    authorizePeer: hex => hex === publicKeyHex ? { deviceId: 'phone-live', capabilities: ['view'] } : undefined,
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const dropped = async (act: () => void): Promise<MobileConnectionError> => {
      const phone = phoneClient(server.port!, hostKey, phoneKey);
      await phone.connect();
      const reason = new Promise<MobileConnectionError>(resolve => phone.onClose(resolve));
      act();
      return reason;
    };
    assert.equal((await dropped(() => server.dropDevice('phone-live'))).code, 'device-revoked');
    assert.equal((await dropped(() => server.dropAll(mobileConnectionStatus('host-key-reset')))).code, 'host-key-reset');
    const shutdown = await dropped(() => void server.stop());
    assert.equal(shutdown.code, 'host-shutdown');
    assert.equal(shutdown.retryable, true);
  } finally {
    await server.stop();
  }
});

test('a new peer starts live, replays on request, and learns about unsupported reads', async () => {
  const hostKey = generateKeyPair();
  const app = fixtureApp();
  const append = (sequence: number): void => app.ledger.appendEvent({
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    emittedAt: new Date().toISOString(),
    target: { hostId: 'host', projectId: 'p1', sessionId: 's1' },
    event: { type: 'session.snapshot' },
  });
  append(1);
  append(2);
  const server = new MobileLanServer({ app, hostStaticKey: hostKey });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  const phone = phoneClient(server.port!, hostKey);
  const seen: number[] = [];
  phone.onEvent(envelope => seen.push(envelope.sequence));
  try {
    await phone.connect();
    append(3);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(seen, [3], 'history is not pushed unasked');
    const replay = await phone.replay(1);
    assert.equal(replay.latestSequence, 3);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(seen, [3, 2, 3]);
    await assert.rejects(phone.read({ ...readProject, operation: 'providers.list' }), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === 'unsupported-operation' && /Update Praxis on the desktop/.test(error.message));
  } finally {
    phone.close();
    await server.stop();
  }
});

test('revoking a device closes its open socket', async () => {
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const publicKeyHex = Buffer.from(phoneKey.publicKey).toString('hex');
  const server = new MobileLanServer({
    app: fixtureApp(),
    hostStaticKey: hostKey,
    authorizePeer: hex => hex === publicKeyHex ? { deviceId: 'phone-live', capabilities: ['view'] } : undefined,
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const channel = SecureChannel.initiator({ staticKeyPair: phoneKey, remoteStaticPublicKey: hostKey.publicKey });
      const assembler = new RecordAssembler();
      const connection = net.createConnection({ host: '127.0.0.1', port: server.port! }, () => connection.write(channel.nextHandshakeMessage()));
      connection.on('error', reject);
      connection.on('data', (chunk: Buffer) => {
        for (const record of assembler.push(chunk)) {
          if (!channel.open) channel.readHandshakeMessage(record);
        }
        if (channel.open) resolve(connection);
      });
      connection.setTimeout(3000, () => reject(new Error('timed out')));
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.connectionCount(), 1);
    assert.equal(server.dropDevice('phone-live'), 1);
    assert.equal(server.connectionCount(), 0);
    socket.destroy();
  } finally {
    await server.stop();
  }
});
