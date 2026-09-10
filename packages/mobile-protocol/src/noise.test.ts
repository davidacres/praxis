import assert from 'node:assert/strict';
import test from 'node:test';
import { Handshake, generateKeyPair, type NoisePattern } from './noise';
import vectorFile from './noiseVectors.fixture.json';

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_static?: string;
  resp_ephemeral: string;
  messages: Array<{ payload: string; ciphertext: string }>;
}

const vectors = (vectorFile as { vectors: Vector[] }).vectors;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const patternOf = (name: string): NoisePattern => name.split('_')[1] as NoisePattern;

for (const vector of vectors) {
  const pattern = patternOf(vector.protocol_name);
  test(`${vector.protocol_name} matches the snow test vector`, () => {
    const prologue = fromHex(vector.init_prologue);
    const initiator = new Handshake({
      pattern,
      initiator: true,
      prologue,
      ...(vector.init_static ? { staticKeyPair: generateKeyPair(fromHex(vector.init_static)) } : {}),
      ...(vector.init_remote_static ? { remoteStaticPublicKey: fromHex(vector.init_remote_static) } : {}),
      ephemeralKeyPair: generateKeyPair(fromHex(vector.init_ephemeral)),
    });
    const responder = new Handshake({
      pattern,
      initiator: false,
      prologue,
      ...(vector.resp_static ? { staticKeyPair: generateKeyPair(fromHex(vector.resp_static)) } : {}),
      ephemeralKeyPair: generateKeyPair(fromHex(vector.resp_ephemeral)),
    });

    const handshakeMessageCount = { IK: 2, NK: 2, XX: 3 }[pattern];

    for (let i = 0; i < vector.messages.length; i += 1) {
      const { payload, ciphertext } = vector.messages[i];
      const initiatorSends = i % 2 === 0;
      const writer = initiatorSends ? initiator : responder;
      const reader = initiatorSends ? responder : initiator;

      if (i < handshakeMessageCount) {
        const produced = writer.writeMessage(fromHex(payload));
        assert.equal(toHex(produced), ciphertext, `message ${i} ciphertext`);
        assert.equal(toHex(reader.readMessage(produced)), payload, `message ${i} payload`);
      } else {
        const writerResult = writer.finished;
        const readerResult = reader.finished;
        assert.ok(writerResult && readerResult, 'both sides finished the handshake');
        const produced = writerResult.send.encryptWithAd(new Uint8Array(0), fromHex(payload));
        assert.equal(toHex(produced), ciphertext, `transport message ${i} ciphertext`);
        assert.equal(toHex(readerResult.receive.decryptWithAd(new Uint8Array(0), produced)), payload, `transport message ${i} payload`);
      }
    }

    const a = initiator.finished!;
    const b = responder.finished!;
    assert.equal(toHex(a.handshakeHash), toHex(b.handshakeHash), 'both sides agree on the handshake hash');
    if (pattern === 'IK' || pattern === 'XX') {
      const responderStaticPublic = toHex(generateKeyPair(fromHex(vector.resp_static!)).publicKey);
      const initiatorStaticPublic = toHex(generateKeyPair(fromHex(vector.init_static!)).publicKey);
      assert.equal(toHex(a.remoteStaticPublicKey!), responderStaticPublic, 'initiator learned the responder static key');
      assert.equal(toHex(b.remoteStaticPublicKey!), initiatorStaticPublic, 'responder learned the initiator static key');
    }
  });
}

test('IK: a live handshake with random keys yields a working two-way channel', () => {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();

  const phoneSide = new Handshake({ pattern: 'IK', initiator: true, staticKeyPair: phone, remoteStaticPublicKey: desktop.publicKey });
  const desktopSide = new Handshake({ pattern: 'IK', initiator: false, staticKeyPair: desktop });

  desktopSide.readMessage(phoneSide.writeMessage(new TextEncoder().encode('hello from the phone')));
  const back = phoneSide.readMessage(desktopSide.writeMessage(new Uint8Array(0)));
  assert.equal(back.length, 0);

  const p = phoneSide.finished!;
  const d = desktopSide.finished!;
  assert.equal(toHex(d.remoteStaticPublicKey!), toHex(phone.publicKey), 'desktop authenticated the phone');

  const ct = p.send.encryptWithAd(new Uint8Array(0), new TextEncoder().encode('approve run-1'));
  assert.equal(new TextDecoder().decode(d.receive.decryptWithAd(new Uint8Array(0), ct)), 'approve run-1');
  const reply = d.send.encryptWithAd(new Uint8Array(0), new TextEncoder().encode('gate.approved'));
  assert.equal(new TextDecoder().decode(p.receive.decryptWithAd(new Uint8Array(0), reply)), 'gate.approved');
});

test('a tampered transport frame is rejected', () => {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();
  const phoneSide = new Handshake({ pattern: 'IK', initiator: true, staticKeyPair: phone, remoteStaticPublicKey: desktop.publicKey });
  const desktopSide = new Handshake({ pattern: 'IK', initiator: false, staticKeyPair: desktop });
  desktopSide.readMessage(phoneSide.writeMessage());
  phoneSide.readMessage(desktopSide.writeMessage());

  const ct = phoneSide.finished!.send.encryptWithAd(new Uint8Array(0), new TextEncoder().encode('approve'));
  ct[ct.length - 1] ^= 0x01;
  assert.throws(() => desktopSide.finished!.receive.decryptWithAd(new Uint8Array(0), ct));
});

test('the wrong pinned desktop key fails the handshake', () => {
  const desktop = generateKeyPair();
  const attacker = generateKeyPair();
  const phone = generateKeyPair();
  const phoneSide = new Handshake({ pattern: 'IK', initiator: true, staticKeyPair: phone, remoteStaticPublicKey: attacker.publicKey });
  const desktopSide = new Handshake({ pattern: 'IK', initiator: false, staticKeyPair: desktop });
  assert.throws(() => desktopSide.readMessage(phoneSide.writeMessage()));
});
