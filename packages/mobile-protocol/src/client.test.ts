import assert from 'node:assert/strict';
import * as net from 'node:net';
import test from 'node:test';
import { MobileSecureClient, type MobileSocketConnector } from './client';
import { generateKeyPair, type KeyPair } from './noise';
import { RecordAssembler, SecureChannel } from './secureChannel';
import { MobileEventCursor, mergeSequencedSnapshot } from './sessionMirror';
import { MobileConnectionError, mobileConnectionStatus, type MobileConnectionStatus, type MobileRequestFrame } from './wire';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

interface Peer {
  send(frame: unknown): void;
  end(): void;
  frames: MobileRequestFrame[];
}

/** A scripted Noise responder: `onOpen` runs after the handshake, `onFrame` for each request. */
async function responder(
  hostKey: KeyPair,
  script: { onOpen(peer: Peer): void; onFrame?(peer: Peer, frame: MobileRequestFrame): void },
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const channel = SecureChannel.responder({ staticKeyPair: hostKey });
    const assembler = new RecordAssembler();
    const peer: Peer = {
      frames: [],
      send: frame => { if (!socket.destroyed) socket.write(channel.encrypt(encode(frame))); },
      end: () => socket.end(),
    };
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const record of assembler.push(chunk)) {
        if (!channel.open) {
          try {
            channel.readHandshakeMessage(record);
          } catch {
            socket.destroy();
            return;
          }
          socket.write(channel.nextHandshakeMessage());
          script.onOpen(peer);
          continue;
        }
        const frame = JSON.parse(new TextDecoder().decode(channel.decrypt(record))) as MobileRequestFrame;
        peer.frames.push(frame);
        script.onFrame?.(peer, frame);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function nodeConnector(port: number): MobileSocketConnector {
  return handlers => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
    socket.on('data', (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
    socket.on('error', error => handlers.onError(error));
    socket.on('close', () => handlers.onClose());
    return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
  };
}

function client(port: number, hostKey: KeyPair, extra: { pairingTokenId?: string; pinned?: Uint8Array; connectTimeoutMs?: number } = {}): MobileSecureClient {
  return new MobileSecureClient({
    connect: nodeConnector(port),
    endpoint: `127.0.0.1:${port}`,
    staticKeyPair: generateKeyPair(),
    remoteStaticPublicKey: extra.pinned ?? hostKey.publicKey,
    connectTimeoutMs: extra.connectTimeoutMs ?? 2_000,
    requestTimeoutMs: 2_000,
    ...(extra.pairingTokenId ? { pairingTokenId: extra.pairingTokenId } : {}),
  });
}

const status = (code: MobileConnectionStatus['code']): { kind: 'status'; status: MobileConnectionStatus } => ({ kind: 'status', status: mobileConnectionStatus(code) });

test('connects on ready, correlates replies, and delivers pushed events', async () => {
  const hostKey = generateKeyPair();
  const host = await responder(hostKey, {
    onOpen: peer => peer.send(status('ready')),
    onFrame: (peer, frame) => {
      peer.send({ kind: 'event', envelope: { sequence: 7 } });
      peer.send({ id: frame.id, kind: 'reply', ok: true, value: { echoed: frame.payload } });
    },
  });
  const phone = client(host.port, hostKey);
  const events: number[] = [];
  phone.onEvent(envelope => events.push(envelope.sequence));
  try {
    await phone.connect();
    assert.equal(phone.isReady, true);
    assert.deepEqual(await phone.read({ operation: 'host.info' }), { echoed: { operation: 'host.info' } });
    assert.deepEqual(events, [7]);
  } finally {
    phone.close();
    await host.close();
  }
});

test('presents the invitation token and stays pending until the desktop confirms', async () => {
  const hostKey = generateKeyPair();
  let confirm: (() => void) | undefined;
  const host = await responder(hostKey, {
    onOpen: peer => peer.send(status('pairing-required')),
    onFrame: (peer, frame) => {
      if (frame.kind !== 'pair') return;
      assert.deepEqual(frame.payload, { tokenId: 'invite-123' });
      peer.send(status('pairing-pending'));
      confirm = () => peer.send(status('ready'));
    },
  });
  const phone = client(host.port, hostKey, { pairingTokenId: 'invite-123', connectTimeoutMs: 300 });
  const seen: string[] = [];
  phone.onStatus(next => {
    seen.push(next.code);
    // Confirmation arrives long after the connect timeout: pending must not time out.
    if (next.code === 'pairing-pending') setTimeout(() => confirm?.(), 500);
  });
  try {
    await phone.connect();
    assert.deepEqual(seen, ['pairing-required', 'pairing-pending', 'ready']);
  } finally {
    phone.close();
    await host.close();
  }
});

test('an unknown phone without an invitation is told to pair', async () => {
  const hostKey = generateKeyPair();
  const host = await responder(hostKey, { onOpen: peer => peer.send(status('pairing-required')) });
  try {
    await assert.rejects(client(host.port, hostKey).connect(), (error: unknown) => {
      assert.ok(error instanceof MobileConnectionError);
      assert.equal(error.code, 'pairing-required');
      assert.match(error.message, /Scan a current pairing invitation/);
      return true;
    });
  } finally {
    await host.close();
  }
});

test('a refusal status survives the socket closing and names the reason', async () => {
  const hostKey = generateKeyPair();
  const host = await responder(hostKey, {
    onOpen: peer => {
      peer.send(status('pairing-required'));
    },
    onFrame: peer => {
      peer.send(status('invitation-expired'));
      peer.end();
    },
  });
  try {
    await assert.rejects(client(host.port, hostKey, { pairingTokenId: 'old-token' }).connect(), (error: unknown) => {
      assert.ok(error instanceof MobileConnectionError);
      assert.equal(error.code, 'invitation-expired');
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    await host.close();
  }
});

test('a desktop that rejects the pinned key surfaces as a handshake rejection', async () => {
  const hostKey = generateKeyPair();
  const host = await responder(hostKey, { onOpen: peer => peer.send(status('ready')) });
  try {
    await assert.rejects(client(host.port, hostKey, { pinned: generateKeyPair().publicKey }).connect(), (error: unknown) => {
      assert.ok(error instanceof MobileConnectionError);
      assert.equal(error.code, 'handshake-rejected');
      assert.match(error.message, /host key may have been reset/);
      return true;
    });
  } finally {
    await host.close();
  }
});

test('a closed port is reported as unreachable with the endpoint', async () => {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await assert.rejects(client(port, generateKeyPair()).connect(), (error: unknown) => {
    assert.ok(error instanceof MobileConnectionError);
    assert.equal(error.code, 'unreachable');
    assert.equal(error.retryable, true);
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    return true;
  });
});

test('losing an established session reports why: status first, otherwise connection-lost', async () => {
  const hostKey = generateKeyPair();
  let revoke: (() => void) | undefined;
  let drop: (() => void) | undefined;
  const host = await responder(hostKey, {
    onOpen: peer => {
      peer.send(status('ready'));
      if (!revoke) revoke = () => { peer.send(status('device-revoked')); peer.end(); };
      else drop = () => peer.end();
    },
  });
  try {
    const revoked = client(host.port, hostKey);
    await revoked.connect();
    const revokedReason = new Promise<MobileConnectionError>(resolve => revoked.onClose(resolve));
    revoke!();
    assert.equal((await revokedReason).code, 'device-revoked');

    const dropped = client(host.port, hostKey);
    await dropped.connect();
    const droppedReason = new Promise<MobileConnectionError>(resolve => dropped.onClose(resolve));
    drop!();
    const error = await droppedReason;
    assert.equal(error.code, 'connection-lost');
    assert.equal(error.retryable, true);
  } finally {
    await host.close();
  }
});

test('a desktop from before status frames is treated as ready after a quiet handshake', async () => {
  const hostKey = generateKeyPair();
  const host = await responder(hostKey, {
    onOpen: () => undefined,
    onFrame: (peer, frame) => peer.send({ id: frame.id, kind: 'reply', ok: true, value: 'legacy' }),
  });
  const phone = new MobileSecureClient({
    connect: nodeConnector(host.port),
    endpoint: `127.0.0.1:${host.port}`,
    staticKeyPair: generateKeyPair(),
    remoteStaticPublicKey: hostKey.publicKey,
    connectTimeoutMs: 2_000,
    legacyReadyAfterMs: 100,
  });
  try {
    await phone.connect();
    assert.equal(phone.status, undefined);
    assert.equal(await phone.read({}), 'legacy');
  } finally {
    phone.close();
    await host.close();
  }
});

test('snapshots merge by sequence so replay never duplicates or regresses a session', () => {
  let sessions = mergeSequencedSnapshot({}, { sessionId: 's1', sequence: 5, messages: ['hi', 'streamed reply'] });
  const stale = mergeSequencedSnapshot(sessions, { sessionId: 's1', sequence: 3, messages: ['hi'] });
  assert.equal(stale, sessions, 'an older replayed snapshot is ignored');
  sessions = mergeSequencedSnapshot(sessions, { sessionId: 's1', sequence: 5, messages: ['hi', 'streamed reply'] });
  assert.deepEqual(sessions.s1?.messages, ['hi', 'streamed reply'], 'a re-delivered snapshot replaces rather than appends');
  sessions = mergeSequencedSnapshot(sessions, { sessionId: 's1', sequence: 9, messages: ['hi', 'streamed reply', 'next'] });
  assert.equal(sessions.s1?.messages.length, 3);

  const cursor = new MobileEventCursor(4);
  assert.equal(cursor.observe(5), true);
  assert.equal(cursor.observe(5), false);
  assert.equal(cursor.observe(2), false);
  assert.equal(cursor.sequence, 5);
});
