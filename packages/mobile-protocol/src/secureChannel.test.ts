import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair } from './noise';
import { RecordAssembler, SecureChannel, completeHandshake, frame } from './secureChannel';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const str = (value: Uint8Array): string => new TextDecoder().decode(value);

test('RecordAssembler reassembles records split across chunks', () => {
  const asm = new RecordAssembler();
  const wire = frame(text('alpha'));
  assert.deepEqual(asm.push(wire.slice(0, 3)), []);
  assert.deepEqual(asm.push(wire.slice(3)).map(str), ['alpha']);
});

test('RecordAssembler splits several records from one chunk', () => {
  const asm = new RecordAssembler();
  const chunk = new Uint8Array([...frame(text('a')), ...frame(text('bb')), ...frame(text('ccc'))]);
  assert.deepEqual(asm.push(chunk).map(str), ['a', 'bb', 'ccc']);
});

test('IK channel: handshake then a two-way encrypted conversation', () => {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();
  const prologue = text('praxis-pairing:token-1');

  const initiator = SecureChannel.initiator({ staticKeyPair: phone, remoteStaticPublicKey: desktop.publicKey, prologue });
  const responder = SecureChannel.responder({ staticKeyPair: desktop, prologue });

  completeHandshake(initiator, responder);
  assert.equal(initiator.open && responder.open, true);
  assert.deepEqual([...responder.peerStaticPublicKey!], [...phone.publicKey], 'desktop authenticated the phone');
  assert.deepEqual([...initiator.peerStaticPublicKey!], [...desktop.publicKey], 'phone authenticated the desktop');

  const asm = new RecordAssembler();
  const [wire] = asm.push(initiator.encrypt(text('{"op":"workflowGates.approve"}')));
  assert.equal(str(responder.decrypt(wire)), '{"op":"workflowGates.approve"}');

  const back = new RecordAssembler();
  const [reply] = back.push(responder.encrypt(text('{"event":"gate.approved"}')));
  assert.equal(str(initiator.decrypt(reply)), '{"event":"gate.approved"}');
});

test('a channel bound to a different pairing prologue cannot complete', () => {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();
  const initiator = SecureChannel.initiator({ staticKeyPair: phone, remoteStaticPublicKey: desktop.publicKey, prologue: text('token-A') });
  const responder = SecureChannel.responder({ staticKeyPair: desktop, prologue: text('token-B') });
  assert.throws(() => completeHandshake(initiator, responder));
});

test('the initiator must pin a responder key', () => {
  assert.throws(() => SecureChannel.initiator({ staticKeyPair: generateKeyPair() }), /pin the responder static key/);
});

test('encrypt/decrypt before the handshake completes is refused', () => {
  const responder = SecureChannel.responder({ staticKeyPair: generateKeyPair() });
  assert.throws(() => responder.encrypt(text('x')), /not open/);
});

test('an oversize frame is rejected by the assembler', () => {
  const asm = new RecordAssembler();
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, (1 << 20) + 1, false);
  assert.throws(() => asm.push(header), /over the/);
});
