/**
 * A Noise `IK` channel with length-prefixed framing, ready to sit on any byte
 * stream (a LAN socket, the loopback fixture). The initiator is the phone; it
 * pins the responder's (desktop's) static public key from pairing. After a
 * one-round-trip handshake, `encrypt` / `decrypt` carry application frames.
 *
 * Framing: every record is a 4-byte big-endian length followed by that many
 * bytes. `feed()` buffers stream input and yields complete records.
 */
import { CipherState, Handshake, type KeyPair } from './noise';

const MAX_RECORD = 1 << 20; // 1 MiB — a mobile control message is tiny; anything larger is a fault.

export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_RECORD) throw new Error(`Record of ${payload.length} bytes exceeds the ${MAX_RECORD} limit.`);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/** Buffers stream bytes and emits whole records as they complete. */
export class RecordAssembler {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const records: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (length > MAX_RECORD) throw new Error(`Framed record claims ${length} bytes, over the ${MAX_RECORD} limit.`);
      if (this.buffer.length < 4 + length) break;
      records.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.slice(4 + length);
    }
    return records;
  }
}

export interface SecureChannelOptions {
  /** This endpoint's long-term identity keypair. */
  staticKeyPair: KeyPair;
  /** Initiator only: the responder's static public key, pinned at pairing. */
  remoteStaticPublicKey?: Uint8Array;
  /** Bound into the handshake so a channel is only usable for its pairing context. */
  prologue?: Uint8Array;
  /** Test-only: force the ephemeral keypair. */
  ephemeralKeyPair?: KeyPair;
}

/**
 * One end of a Noise IK channel. Drive the handshake with
 * `nextHandshakeMessage()` / `readHandshakeMessage()` until `open` is true,
 * then use `encrypt` / `decrypt`.
 */
export class SecureChannel {
  private readonly handshake: Handshake;
  private readonly initiator: boolean;
  private send?: CipherState;
  private receive?: CipherState;
  private remoteStatic?: Uint8Array;

  private constructor(initiator: boolean, options: SecureChannelOptions) {
    this.initiator = initiator;
    this.handshake = new Handshake({
      pattern: 'IK',
      initiator,
      staticKeyPair: options.staticKeyPair,
      ...(options.remoteStaticPublicKey ? { remoteStaticPublicKey: options.remoteStaticPublicKey } : {}),
      ...(options.prologue ? { prologue: options.prologue } : {}),
      ...(options.ephemeralKeyPair ? { ephemeralKeyPair: options.ephemeralKeyPair } : {}),
    });
  }

  static initiator(options: SecureChannelOptions): SecureChannel {
    if (!options.remoteStaticPublicKey) throw new Error('The initiator must pin the responder static key.');
    return new SecureChannel(true, options);
  }

  static responder(options: SecureChannelOptions): SecureChannel {
    return new SecureChannel(false, options);
  }

  get open(): boolean {
    return this.send !== undefined && this.receive !== undefined;
  }

  /** The peer's authenticated static public key, once the handshake completes. */
  get peerStaticPublicKey(): Uint8Array | undefined {
    return this.remoteStatic;
  }

  /** The next handshake record to send, framed. Throws if it is the peer's turn. */
  nextHandshakeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.open) throw new Error('The handshake is already complete.');
    const record = frame(this.handshake.writeMessage(payload));
    this.captureResult();
    return record;
  }

  /** Consume a framed handshake record from the peer. */
  readHandshakeMessage(record: Uint8Array): Uint8Array {
    if (this.open) throw new Error('The handshake is already complete.');
    const payload = this.handshake.readMessage(record);
    this.captureResult();
    return payload;
  }

  private captureResult(): void {
    const result = this.handshake.finished;
    if (!result) return;
    this.send = result.send;
    this.receive = result.receive;
    this.remoteStatic = result.remoteStaticPublicKey;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.send) throw new Error('The channel is not open.');
    return frame(this.send.encryptWithAd(new Uint8Array(0), plaintext));
  }

  decrypt(record: Uint8Array): Uint8Array {
    if (!this.receive) throw new Error('The channel is not open.');
    return this.receive.decryptWithAd(new Uint8Array(0), record);
  }
}

/**
 * Runs the IK handshake to completion over two in-process channels, returning
 * once both are open. `deliver` sends a framed record to the other side and
 * returns its framed reply (or an empty array when the peer had nothing to
 * send). Used by the loopback fixture and tests; a real socket drives the same
 * `nextHandshakeMessage` / `readHandshakeMessage` pair asynchronously.
 */
export function completeHandshake(initiator: SecureChannel, responder: SecureChannel): void {
  const asm = new RecordAssembler();
  // IK is two messages: -> e,es,s,ss  then  <- e,ee,se
  for (const record of asm.push(initiator.nextHandshakeMessage())) responder.readHandshakeMessage(record);
  const back = new RecordAssembler();
  for (const record of back.push(responder.nextHandshakeMessage())) initiator.readHandshakeMessage(record);
  if (!initiator.open || !responder.open) throw new Error('The handshake did not complete.');
}
