import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';
import WebSocket from 'ws';
import { RELAY_CLOSE, RELAY_SIGNATURE_CONTEXT, RelayServer, channelIdForKey, type RelayLimits } from './relayServer';

interface HostKey {
  publicKeyHex: string;
  privateKey: KeyObject;
}

function hostKey(): HostKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKeyHex: der.subarray(der.length - 32).toString('hex'), privateKey };
}

const signNonce = (key: HostKey, nonce: string): string =>
  sign(null, Buffer.from(RELAY_SIGNATURE_CONTEXT + nonce, 'utf8'), key.privateKey).toString('hex');

async function withRelay(limits: Partial<RelayLimits>, body: (relay: RelayServer, url: string, logs: string[]) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const relay = new RelayServer({ port: 0, host: '127.0.0.1', limits, onLog: line => logs.push(line) });
  await relay.start();
  try {
    await body(relay, `ws://127.0.0.1:${relay.port}`, logs);
  } finally {
    await relay.stop();
  }
}

const opened = (ws: WebSocket): Promise<void> => new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
const closed = (ws: WebSocket): Promise<number> => new Promise(resolve => ws.once('close', code => resolve(code)));
const nextMessage = (ws: WebSocket): Promise<Buffer> => new Promise(resolve => ws.once('message', data => resolve(data as Buffer)));
const nextJson = async (ws: WebSocket): Promise<Record<string, unknown>> => JSON.parse((await nextMessage(ws)).toString()) as Record<string, unknown>;

/** Registers a host control socket and returns it with its channel id. */
async function register(url: string, key: HostKey): Promise<{ control: WebSocket; channel: string }> {
  const control = new WebSocket(`${url}/v1/host?key=${key.publicKeyHex}`);
  const challenge = nextJson(control);
  await opened(control);
  const { nonce } = (await challenge) as { nonce: string };
  const registered = nextJson(control);
  control.send(JSON.stringify({ type: 'auth', signature: signNonce(key, nonce) }));
  const { channel } = (await registered) as { channel: string };
  return { control, channel };
}

test('a host registers, a phone connects, and bytes flow both ways in order', async () => {
  await withRelay({}, async (_relay, url) => {
    const key = hostKey();
    const { control, channel } = await register(url, key);
    assert.equal(channel, channelIdForKey(key.publicKeyHex));

    const incoming = nextJson(control);
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    // Sent before the host attaches: must be buffered and delivered first, in order.
    phone.send(Buffer.from('one'));
    phone.send(Buffer.from('two'));
    const { conn } = (await incoming) as { type: string; conn: string };

    const accept = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${conn}`);
    const seen: string[] = [];
    accept.on('message', data => seen.push((data as Buffer).toString()));
    await opened(accept);
    phone.send(Buffer.from('three'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(seen, ['one', 'two', 'three']);

    const reply = nextMessage(phone);
    accept.send(Buffer.from('pong'));
    assert.equal((await reply).toString(), 'pong');
    phone.close();
    accept.close();
    control.close();
  });
});

test('a host that cannot sign the challenge is refused and registers nothing', async () => {
  await withRelay({}, async (relay, url) => {
    const real = hostKey();
    const impostor = hostKey();
    const control = new WebSocket(`${url}/v1/host?key=${real.publicKeyHex}`);
    const challenge = nextJson(control);
    await opened(control);
    const { nonce } = (await challenge) as { nonce: string };
    const done = closed(control);
    control.send(JSON.stringify({ type: 'auth', signature: signNonce(impostor, nonce) }));
    assert.equal(await done, RELAY_CLOSE.authFailed);
    assert.equal(relay.channelCount(), 0);
  });
});

test('a signature over one nonce is useless for another connection', async () => {
  await withRelay({}, async (_relay, url) => {
    const key = hostKey();
    const first = new WebSocket(`${url}/v1/host?key=${key.publicKeyHex}`);
    const firstChallenge = nextJson(first);
    await opened(first);
    const { nonce: oldNonce } = (await firstChallenge) as { nonce: string };
    first.close();

    const second = new WebSocket(`${url}/v1/host?key=${key.publicKeyHex}`);
    await opened(second);
    const done = closed(second);
    second.send(JSON.stringify({ type: 'auth', signature: signNonce(key, oldNonce) }));
    assert.equal(await done, RELAY_CLOSE.authFailed);
  });
});

test('an unauthenticated host times out', async () => {
  await withRelay({ authTimeoutMs: 100 }, async (_relay, url) => {
    const control = new WebSocket(`${url}/v1/host?key=${hostKey().publicKeyHex}`);
    await opened(control);
    assert.equal(await closed(control), RELAY_CLOSE.authFailed);
  });
});

test('a guessed channel id gets no route', async () => {
  await withRelay({}, async (_relay, url) => {
    const phone = new WebSocket(`${url}/v1/connect?channel=${'0'.repeat(32)}`);
    await opened(phone);
    assert.equal(await closed(phone), RELAY_CLOSE.hostOffline);
  });
});

test('accept with an unknown or reused connection id is refused', async () => {
  await withRelay({}, async (_relay, url) => {
    const { control, channel } = await register(url, hostKey());
    const incoming = nextJson(control);
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    const { conn } = (await incoming) as { conn: string };

    const forged = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${'f'.repeat(32)}`);
    await opened(forged);
    assert.equal(await closed(forged), RELAY_CLOSE.badRequest);

    const accept = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${conn}`);
    await opened(accept);
    const reused = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${conn}`);
    await opened(reused);
    assert.equal(await closed(reused), RELAY_CLOSE.badRequest);
    phone.close();
  });
});

test('a phone the host never answers is closed after the accept timeout', async () => {
  await withRelay({ acceptTimeoutMs: 100 }, async (_relay, url) => {
    const { channel } = await register(url, hostKey());
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    assert.equal(await closed(phone), RELAY_CLOSE.waitTimeout);
  });
});

test('pending connections per channel are capped', async () => {
  await withRelay({ maxPendingPerChannel: 2 }, async (_relay, url) => {
    const { channel } = await register(url, hostKey());
    const a = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    const b = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await Promise.all([opened(a), opened(b)]);
    const c = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(c);
    assert.equal(await closed(c), RELAY_CLOSE.tooManyPeers);
    a.close();
    b.close();
  });
});

test('an oversized message closes the socket', async () => {
  await withRelay({ maxMessageBytes: 1024 }, async (_relay, url) => {
    const { channel } = await register(url, hostKey());
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    const done = closed(phone);
    phone.send(Buffer.alloc(4096));
    assert.equal(await done, 1009);
  });
});

test('a phone that floods before the host attaches hits the buffer limit', async () => {
  await withRelay({ maxBufferedBytes: 100 }, async (_relay, url) => {
    const { channel } = await register(url, hostKey());
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    const done = closed(phone);
    phone.send(Buffer.alloc(200));
    assert.equal(await done, RELAY_CLOSE.rateLimited);
  });
});

test('sustained traffic beyond the byte budget is cut off', async () => {
  await withRelay({ bytesPerSecond: 10, burstBytes: 100 }, async (_relay, url) => {
    const { channel } = await register(url, hostKey());
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    const done = closed(phone);
    phone.send(Buffer.alloc(90));
    phone.send(Buffer.alloc(90));
    assert.equal(await done, RELAY_CLOSE.rateLimited);
  });
});

test('the host going offline closes its phones and frees the channel', async () => {
  await withRelay({}, async (relay, url) => {
    const { control, channel } = await register(url, hostKey());
    const incoming = nextJson(control);
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    const { conn } = (await incoming) as { conn: string };
    const accept = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${conn}`);
    await opened(accept);
    const phoneClosed = closed(phone);
    control.close();
    assert.equal(await phoneClosed, RELAY_CLOSE.hostOffline);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(relay.channelCount(), 0);
  });
});

test('a newer registration replaces the older one', async () => {
  await withRelay({}, async (relay, url) => {
    const key = hostKey();
    const first = await register(url, key);
    const replaced = closed(first.control);
    await register(url, key);
    assert.equal(await replaced, RELAY_CLOSE.replaced);
    assert.equal(relay.channelCount(), 1);
  });
});

test('connections per address are rate limited before the upgrade', async () => {
  await withRelay({ maxConnectsPerMinute: 2 }, async (_relay, url) => {
    const a = new WebSocket(`${url}/v1/connect?channel=${'0'.repeat(32)}`);
    const b = new WebSocket(`${url}/v1/connect?channel=${'0'.repeat(32)}`);
    a.on('error', () => undefined);
    b.on('error', () => undefined);
    await Promise.all([closed(a), closed(b)]);
    const c = new WebSocket(`${url}/v1/connect?channel=${'0'.repeat(32)}`);
    const error = await new Promise<Error>(resolve => c.once('error', resolve));
    assert.match(error.message, /429/);
  });
});

test('payloads and keys never reach the log', async () => {
  await withRelay({}, async (_relay, url, logs) => {
    const key = hostKey();
    const { control, channel } = await register(url, key);
    const incoming = nextJson(control);
    const phone = new WebSocket(`${url}/v1/connect?channel=${channel}`);
    await opened(phone);
    phone.send(Buffer.from('TOP-SECRET-PAYLOAD'));
    const { conn } = (await incoming) as { conn: string };
    const accept = new WebSocket(`${url}/v1/accept?channel=${channel}&conn=${conn}`);
    await opened(accept);
    await new Promise(resolve => setTimeout(resolve, 50));
    const joined = logs.join('\n');
    assert.ok(!joined.includes('TOP-SECRET-PAYLOAD'));
    assert.ok(!joined.includes(key.publicKeyHex));
    assert.ok(!joined.includes(channel), 'the full channel id is not logged');
    phone.close();
    accept.close();
  });
});
