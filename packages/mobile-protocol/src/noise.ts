/**
 * Noise Protocol Framework — the `*_25519_ChaChaPoly_SHA256` suite, patterns
 * IK / NK / XX. Built from audited primitives (`@noble/curves`, `@noble/ciphers`,
 * `@noble/hashes`); the state machine follows the Noise spec (rev 34) and is
 * guarded against the canonical `snow` test vectors in `noise.test.ts`.
 *
 * Pure and dependency-light so it runs unchanged in Node, a browser, and React
 * Native. The product uses `IK`: the phone (initiator) already holds the
 * desktop's static public key from pairing, so one round trip reaches a
 * mutually authenticated, forward-secret channel with no certificates.
 *
 * This module is the cryptographic core only — framing over a socket, the
 * pairing exchange that distributes the static keys, and key rotation policy
 * live in the transport layer that wraps it.
 */
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
const MAX_NONCE = 2n ** 64n - 1n;

export type NoisePattern = 'IK' | 'NK' | 'XX';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(seed?: Uint8Array): KeyPair {
  const privateKey = seed ? seed.slice(0, DHLEN) : x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(keyPair.privateKey, publicKey);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Noise HKDF: HMAC-SHA256 chain producing 2 or 3 HASHLEN outputs. */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)));
  if (outputs === 2) return [o1, o2];
  const o3 = hmac(sha256, tempKey, concat(o2, Uint8Array.of(3)));
  return [o1, o2, o3];
}

function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12); // 32 zero bits || 64-bit little-endian counter
  const view = new DataView(out.buffer);
  view.setBigUint64(4, n, true);
  return out;
}

/** Noise CipherState — an AEAD key plus a monotonic 64-bit nonce. */
export class CipherState {
  private key: Uint8Array | undefined;
  private nonce = 0n;

  constructor(key?: Uint8Array) {
    this.key = key;
  }

  hasKey(): boolean {
    return this.key !== undefined;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.nonce > MAX_NONCE) throw new Error('Noise nonce exhausted; rekey required.');
    const out = chacha20poly1305(this.key, nonceBytes(this.nonce), ad).encrypt(plaintext);
    this.nonce += 1n;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.nonce > MAX_NONCE) throw new Error('Noise nonce exhausted; rekey required.');
    const out = chacha20poly1305(this.key, nonceBytes(this.nonce), ad).decrypt(ciphertext);
    this.nonce += 1n;
    return out;
  }

  /** Replaces the key with ENCRYPT(k, 2^64-1, [], zeros) — forward-secret ratchet, nonce untouched. */
  rekey(): void {
    if (!this.key) throw new Error('Cannot rekey a CipherState with no key.');
    const material = chacha20poly1305(this.key, nonceBytes(MAX_NONCE), new Uint8Array(0)).encrypt(new Uint8Array(HASHLEN + TAGLEN).fill(0));
    this.key = material.slice(0, HASHLEN);
  }

  get nonceValue(): bigint {
    return this.nonce;
  }
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher: CipherState;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    this.h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : sha256(name);
    this.ck = this.h.slice();
    this.cipher = new CipherState();
  }

  mixKey(input: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, input, 2);
    this.ck = ck;
    this.cipher = new CipherState(tempK.slice(0, HASHLEN));
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2);
    return [new CipherState(k1.slice(0, HASHLEN)), new CipherState(k2.slice(0, HASHLEN))];
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss';

const PATTERNS: Record<NoisePattern, { preInitiator: Token[]; preResponder: Token[]; messages: Token[][] }> = {
  IK: { preInitiator: [], preResponder: ['s'], messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  NK: { preInitiator: [], preResponder: ['s'], messages: [['e', 'es'], ['e', 'ee']] },
  XX: { preInitiator: [], preResponder: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
};

export interface HandshakeInit {
  pattern: NoisePattern;
  initiator: boolean;
  prologue?: Uint8Array;
  staticKeyPair?: KeyPair;
  remoteStaticPublicKey?: Uint8Array;
  /** Test-only: force the ephemeral keypair(s) instead of generating them. */
  ephemeralKeyPair?: KeyPair;
}

export interface HandshakeResult {
  send: CipherState;
  receive: CipherState;
  handshakeHash: Uint8Array;
  remoteStaticPublicKey?: Uint8Array;
}

/** A Noise handshake in progress. Alternate `writeMessage` / `readMessage` per the pattern. */
export class Handshake {
  private readonly sym: SymmetricState;
  private readonly initiator: boolean;
  private readonly s?: KeyPair;
  private e?: KeyPair;
  private rs?: Uint8Array;
  private re?: Uint8Array;
  private readonly queue: Token[][];
  private forcedEphemeral?: KeyPair;
  private result?: HandshakeResult;

  constructor(init: HandshakeInit) {
    const spec = PATTERNS[init.pattern];
    this.initiator = init.initiator;
    this.s = init.staticKeyPair;
    this.rs = init.remoteStaticPublicKey;
    this.forcedEphemeral = init.ephemeralKeyPair;
    this.queue = spec.messages.map(tokens => [...tokens]);

    this.sym = new SymmetricState(`Noise_${init.pattern}_25519_ChaChaPoly_SHA256`);
    this.sym.mixHash(init.prologue ?? new Uint8Array(0));

    for (const token of spec.preInitiator) this.mixPre(token, true);
    for (const token of spec.preResponder) this.mixPre(token, false);
  }

  private mixPre(token: Token, isInitiatorSide: boolean): void {
    if (token !== 's' && token !== 'e') return;
    const usingLocal = isInitiatorSide === this.initiator;
    const pub = usingLocal
      ? token === 's'
        ? this.s?.publicKey
        : this.e?.publicKey
      : token === 's'
        ? this.rs
        : this.re;
    if (!pub) throw new Error(`Missing key for pre-message token "${token}".`);
    this.sym.mixHash(pub);
  }

  get done(): boolean {
    return this.queue.length === 0;
  }

  get finished(): HandshakeResult | undefined {
    return this.result;
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const tokens = this.queue.shift();
    if (!tokens) throw new Error('The handshake has no more messages to write.');
    let message: Uint8Array = new Uint8Array(0);
    for (const token of tokens) {
      if (token === 'e') {
        this.e = this.forcedEphemeral ?? generateKeyPair();
        this.forcedEphemeral = undefined;
        message = concat(message, this.e.publicKey);
        this.sym.mixHash(this.e.publicKey);
      } else if (token === 's') {
        if (!this.s) throw new Error('This handshake has no static key to send.');
        message = concat(message, this.sym.encryptAndHash(this.s.publicKey));
      } else {
        this.mixDh(token);
      }
    }
    message = concat(message, this.sym.encryptAndHash(payload));
    if (this.done) this.finish();
    return message;
  }

  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.queue.shift();
    if (!tokens) throw new Error('The handshake has no more messages to read.');
    let offset = 0;
    for (const token of tokens) {
      if (token === 'e') {
        this.re = message.slice(offset, offset + DHLEN);
        offset += DHLEN;
        this.sym.mixHash(this.re);
      } else if (token === 's') {
        const length = this.sym.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN;
        this.rs = this.sym.decryptAndHash(message.slice(offset, offset + length));
        offset += length;
      } else {
        this.mixDh(token);
      }
    }
    const payload = this.sym.decryptAndHash(message.slice(offset));
    if (this.done) this.finish();
    return payload;
  }

  private mixDh(token: Token): void {
    if (!this.e && (token === 'ee' || (this.initiator && token === 'es') || (!this.initiator && token === 'se'))) {
      throw new Error(`Local ephemeral key missing for DH token "${token}".`);
    }
    let secret: Uint8Array;
    switch (token) {
      case 'ee':
        secret = dh(this.e!, this.re!);
        break;
      case 'es':
        secret = this.initiator ? dh(this.e!, this.rs!) : dh(this.s!, this.re!);
        break;
      case 'se':
        secret = this.initiator ? dh(this.s!, this.re!) : dh(this.e!, this.rs!);
        break;
      case 'ss':
        secret = dh(this.s!, this.rs!);
        break;
      default:
        throw new Error(`Not a DH token: "${token}".`);
    }
    this.sym.mixKey(secret);
  }

  private finish(): void {
    const [c1, c2] = this.sym.split();
    this.result = {
      send: this.initiator ? c1 : c2,
      receive: this.initiator ? c2 : c1,
      handshakeHash: this.sym.h.slice(),
      ...(this.rs ? { remoteStaticPublicKey: this.rs.slice() } : {}),
    };
  }
}
