/**
 * A loopback TCP transport for the mobile host fixture: newline-delimited JSON
 * frames, dispatched through the real `handleMobileRead` / `handleMobileCommand`.
 *
 * Framing here (frame ids, a `replay` frame, server-pushed `event` frames) is a
 * fixture-transport decision, not the frozen protocol — the real transport
 * (FX-BE-077, an encrypted LAN socket) replaces this file while the envelopes
 * it carries stay identical.
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

export interface LoopbackHostHandle {
  port: number;
  connections(): number;
  close(): Promise<void>;
}

function splitFrames(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n')) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim()) onLine(line);
  }
  return rest;
}

export async function startLoopbackMobileHost(app: MobileHostApplication): Promise<LoopbackHostHandle> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = '';
    // Events with a sequence at or below this have already been pushed to this peer.
    let flushed = 0;

    const write = (frame: ServerFrame): void => {
      socket.write(`${JSON.stringify(frame)}\n`);
    };

    const flushEvents = (): void => {
      for (const envelope of app.ledger.replay(flushed)) {
        write({ kind: 'event', envelope });
        flushed = Math.max(flushed, envelope.sequence);
      }
    };

    const handle = async (frame: RequestFrame): Promise<ReplyFrame> => {
      try {
        if (frame.kind === 'replay') {
          const after = Number((frame.payload as { afterSequence?: unknown } | undefined)?.afterSequence ?? 0);
          flushed = Number.isFinite(after) ? after : 0;
          return { id: frame.id, kind: 'reply', ok: true, value: { replaying: true } };
        }
        const value =
          frame.kind === 'command'
            ? await handleMobileCommand(app, frame.payload as MobileCommand)
            : await handleMobileRead(app, frame.payload as MobileReadRequest);
        return { id: frame.id, kind: 'reply', ok: true, value };
      } catch (error) {
        return { id: frame.id, kind: 'reply', ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    socket.on('data', chunk => {
      buffer = splitFrames(buffer + chunk.toString('utf8'), line => {
        const frame = JSON.parse(line) as RequestFrame;
        void handle(frame).then(reply => {
          // Events first, reply last: TCP preserves byte order, so by the time
          // the peer processes the reply and resolves its request promise, every
          // event this frame produced has already been delivered and buffered.
          flushEvents();
          write(reply);
        });
      });
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
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

/**
 * The peer side of the loopback transport: id-correlated request/reply plus a
 * buffer of server-pushed events, which `takeEvents()` drains.
 */
export class LoopbackMobileClient {
  private socket?: net.Socket;
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<string, (reply: ReplyFrame) => void>();
  private readonly events: MobileEventEnvelope[] = [];

  constructor(private readonly host: string, private readonly port: number) {}

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => resolve());
      socket.on('error', reject);
      socket.on('data', chunk => {
        this.buffer = splitFrames(this.buffer + chunk.toString('utf8'), line => {
          const frame = JSON.parse(line) as ServerFrame;
          if (frame.kind === 'event') {
            this.events.push(frame.envelope);
            return;
          }
          const resolver = this.pending.get(frame.id);
          if (resolver) {
            this.pending.delete(frame.id);
            resolver(frame);
          }
        });
      });
      this.socket = socket;
    });
  }

  private send<T>(kind: RequestFrame['kind'], payload: unknown): Promise<LoopbackReply<T>> {
    const socket = this.socket;
    if (!socket) throw new Error('The loopback client is not connected.');
    this.seq += 1;
    const id = `f-${this.seq}`;
    return new Promise<LoopbackReply<T>>(resolve => {
      this.pending.set(id, reply => resolve({ ok: reply.ok, value: reply.value as T, error: reply.error }));
      socket.write(`${JSON.stringify({ id, kind, payload } satisfies RequestFrame)}\n`);
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

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
