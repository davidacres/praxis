// The real compiled TypeScript phone client against the Rust LAN/relay responder.
// Invoked by the opt-in Rust test; dependency root, port, pinned key, optional relay channel.
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const requireDeps = require('node:module').createRequire(path.join(process.argv[2], 'package.json'));
const { MobileSecureClient, generateKeyPair } = requireDeps('@praxis/mobile-protocol');
const port = Number(process.argv[3]);
const pinnedKey = Uint8Array.from(Buffer.from(process.argv[4], 'hex'));
const relayChannel = process.argv[5];
const wire = [];
const events = [];
const connect = handlers => {
  if (relayChannel) {
    const WebSocket = requireDeps('ws');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect?channel=${relayChannel}`);
    socket.on('open', () => handlers.onConnect());
    socket.on('message', (bytes, binary) => { if (binary) { wire.push(Buffer.from(bytes)); handlers.onData(bytes); } });
    socket.on('error', error => handlers.onError(error));
    socket.on('close', () => handlers.onClose());
    return { write: bytes => { wire.push(Buffer.from(bytes)); socket.send(bytes, { binary: true }); }, destroy: () => socket.terminate() };
  }
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
  socket.on('data', bytes => { wire.push(Buffer.from(bytes)); handlers.onData(bytes); });
  socket.on('error', error => handlers.onError(error));
  socket.on('close', () => handlers.onClose());
  return { write: bytes => { wire.push(Buffer.from(bytes)); socket.write(bytes); }, destroy: () => socket.destroy() };
};
const phone = new MobileSecureClient({ connect, endpoint: 'Rust transport proof', staticKeyPair: generateKeyPair(), remoteStaticPublicKey: pinnedKey,
  connectTimeoutMs: 2000, requestTimeoutMs: 2000, legacyReadyAfterMs: 0 });
phone.onEvent(event => events.push(event));
const read = (operation, projectId) => ({ protocolVersion: 1, requestId: 'typescript-read', operation,
  target: { hostId: 'host', ...(projectId ? { projectId } : {}) },
  caller: { deviceId: 'forged-admin', subject: 'forged-admin', capabilities: ['view', 'execute', 'approve'] } });
(async () => {
  try {
    await phone.connect();
    assert.deepEqual(await phone.read(read('projects.snapshot')), { projects: [{ projectId: 'p1' }] });
    const actor = await phone.read(read('work.list', 'p1'));
    assert.equal(actor.deviceId, 'paired-phone');
    assert.equal(actor.subject, undefined);
    assert.deepEqual(actor.capabilities, ['view', 'execute']);
    await assert.rejects(phone.read(read('work.list', 'p2')), /not authorised for project p2/);
    await assert.rejects(phone.read(read('providers.list')), error => error.code === 'unsupported-operation');
    const command = { ...read('sessions.create', 'p1'), commandId: 'typescript-command-01', issuedAt: '2026-11-09T10:00:00.000Z', payload: {} };
    assert.deepEqual(await phone.command(command), actor);
    assert.deepEqual(await phone.command(command), actor);
    await phone.replay(0);
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events[0]?.sequence, 1);
    const bytes = Buffer.concat(wire);
    for (const marker of ['projects.snapshot', 'paired-phone', 'forged-admin']) assert.equal(bytes.includes(marker), false, `plaintext leak: ${marker}`);
    assert.equal(Buffer.from(JSON.stringify(actor)).includes('paired-phone'), true, 'leak detector control');
    console.log(JSON.stringify({ transport: relayChannel ? 'relay' : 'tcp', verified: true, ciphertextBytes: bytes.length }));
  } finally { phone.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
