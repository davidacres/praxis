/**
 * A loopback TCP transport for the mobile host fixture, carried over a real
 * Noise `IK` channel (`@praxis/mobile-protocol`): the client pins the fixture
 * host's static key (as pairing would provide it), both sides run the
 * handshake, and every request / reply / pushed event is an encrypted,
 * length-prefixed record.
 *
 * Application framing above the channel — frame ids, a `replay` request,
 * server-pushed `event` records — is a fixture-transport decision, not the
 * frozen protocol. The real LAN transport (FX-BE-077) swaps this file while the
 * Noise channel and the envelopes it carries stay identical.
 */
import * as net from 'node:net';
import {
  handleMobileCommand,
  handleMobileRead,
  type MobileCommand,
  type MobileEventEnvelope,
  type MobileHostApplication,
  type MobileReadRequest,
} from '@praxis/core';
import { RecordAssembler, SecureChannel, type KeyPair } from '@praxis/mobile-protocol';

export interface RequestFrame {
  id: string;
  kind: 'read' | 'command' | 'replay';
  payload: unknown;
}

export interface ReplyFrame {
  id: string;
  kind: 'reply';
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface EventFrame {
  kind: 'event';
  envelope: MobileEventEnvelope;
}

export type ServerFrame = ReplyFrame | EventFrame;

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

export interface LoopbackHostHandle {
  port: number;
  staticPublicKey: Uint8Array;
  connections(): number;
  close(): Promise<void>;
}

export async function startLoopbackMobileHost(
  app: MobileHostApplication,
  hostStaticKey: KeyPair,
): Promise<LoopbackHostHandle> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer(socket => {
    sockets.add(socket);
    const channel = SecureChannel.responder({ staticKeyPair: hostStaticKey });
    const assembler = new RecordAssembler();
    let flushed = 0;

    const sendPlain = (record: Uint8Array): void => {
      socket.write(record);
    };
    const sendSecure = (frame: ServerFrame): void => {
      socket.write(channel.encrypt(encode(frame)));
    };
    const flushEvents = (): void => {
      for (const envelope of app.ledger.replay(flushed)) {
        sendSecure({ kind: 'event', envelope });
        flushed = Math.max(flushed, envelope.sequence);
      }
    };

    const handle = async (request: RequestFrame): Promise<ReplyFrame> => {
      try {
        if (request.kind === 'replay') {
          const after = Number((request.payload as { afterSequence?: unknown } | undefined)?.afterSequence ?? 0);
          flushed = Number.isFinite(after) ? after : 0;
          return { id: request.id, kind: 'reply', ok: true, value: { replaying: true } };
        }
        const value =
          request.kind === 'command'
            ? await handleMobileCommand(app, request.payload as MobileCommand)
            : await handleMobileRead(app, request.payload as MobileReadRequest);
        return { id: request.id, kind: 'reply', ok: true, value };
      } catch (error) {
        return { id: request.id, kind: 'reply', ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    socket.on('data', (chunk: Buffer) => {
      let records: Uint8Array[];
      try {
        records = assembler.push(chunk);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const record of records) {
        if (!channel.open) {
          // IK: read the initiator's first message, answer with the second.
          channel.readHandshakeMessage(record);
          if (!channel.open) sendPlain(channel.nextHandshakeMessage());
          continue;
        }
        const request = decode<RequestFrame>(channel.decrypt(record));
        void handle(request).then(reply => {
          // Events first, reply last — see the fixture-client note.
          flushEvents();
          sendSecure(reply);
        });
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    staticPublicKey: hostStaticKey.publicKey,
    connections: () => sockets.size,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

export interface LoopbackReply<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** The peer side: pins the host key, runs the handshake, then id-correlated encrypted request/reply plus a buffer of pushed events. */
export class LoopbackMobileClient {
  private socket?: net.Socket;
  private readonly assembler = new RecordAssembler();
  private readonly channel: SecureChannel;
  private seq = 0;
  private readonly pending = new Map<string, (reply: ReplyFrame) => void>();
  private readonly events: MobileEventEnvelope[] = [];
  private ready?: () => void;

  constructor(
    private readonly host: string,
    private readonly port: number,
    identity: KeyPair,
    hostStaticPublicKey: Uint8Array,
  ) {
    this.channel = SecureChannel.initiator({ staticKeyPair: identity, remoteStaticPublicKey: hostStaticPublicKey });
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.ready = resolve;
        socket.write(this.channel.nextHandshakeMessage()); // IK message 1
      });
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        let records: Uint8Array[];
        try {
          records = this.assembler.push(chunk);
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        for (const record of records) {
          if (!this.channel.open) {
            this.channel.readHandshakeMessage(record); // IK message 2
            if (this.channel.open) this.ready?.();
            continue;
          }
          const frame = decode<ServerFrame>(this.channel.decrypt(record));
          if (frame.kind === 'event') {
            this.events.push(frame.envelope);
            continue;
          }
          const resolver = this.pending.get(frame.id);
          if (resolver) {
            this.pending.delete(frame.id);
            resolver(frame);
          }
        }
      });
      this.socket = socket;
    });
  }

  private send<T>(kind: RequestFrame['kind'], payload: unknown): Promise<LoopbackReply<T>> {
    const socket = this.socket;
    if (!socket || !this.channel.open) throw new Error('The loopback client is not connected.');
    this.seq += 1;
    const id = `f-${this.seq}`;
    return new Promise<LoopbackReply<T>>(resolve => {
      this.pending.set(id, reply => resolve({ ok: reply.ok, value: reply.value as T, error: reply.error }));
      socket.write(this.channel.encrypt(encode({ id, kind, payload } satisfies RequestFrame)));
    });
  }

  read<T>(request: MobileReadRequest): Promise<LoopbackReply<T>> {
    return this.send<T>('read', request);
  }

  command<T>(command: MobileCommand): Promise<LoopbackReply<T>> {
    return this.send<T>('command', command);
  }

  requestReplay(afterSequence: number): Promise<LoopbackReply<{ replaying: boolean }>> {
    return this.send<{ replaying: boolean }>('replay', { afterSequence });
  }

  takeEvents(): readonly MobileEventEnvelope[] {
    return this.events.splice(0, this.events.length);
  }

  get peerStaticPublicKey(): Uint8Array | undefined {
    return this.channel.peerStaticPublicKey;
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
