/**
 * The real LAN listener (FX-BE-077): a TCP server that runs the Noise `IK`
 * handshake with each peer (this side is the responder), authorises the
 * authenticated peer against the access policy, then serves encrypted mobile
 * read/command frames through the same `handleMobileRead` / `handleMobileCommand`
 * the IPC bridge uses. Events the host emits are pushed to connected peers.
 *
 * Framing above the Noise channel (frame ids, a `replay` request, pushed
 * `event` records) matches the loopback fixture so a client speaks one wire.
 */
import * as net from 'node:net';
import * as os from 'node:os';
import {
  evaluateMobileAccess,
  handleMobileCommand,
  handleMobileRead,
  type MobileAccessPolicy,
  type MobileCommand,
  type MobileEventEnvelope,
  type MobileHostApplication,
  type MobilePeerContext,
  type MobileReadRequest,
} from '@praxis/core';
import { RecordAssembler, SecureChannel, type KeyPair } from '@praxis/mobile-protocol';

interface RequestFrame {
  id: string;
  kind: 'read' | 'command' | 'replay';
  payload: unknown;
}
interface ReplyFrame {
  id: string;
  kind: 'reply';
  ok: boolean;
  value?: unknown;
  error?: string;
}
type ServerFrame = ReplyFrame | { kind: 'event'; envelope: MobileEventEnvelope };

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

/** The OS interface name a local address belongs to, for the policy allowlist. */
function interfaceNameFor(localAddress: string | undefined): string {
  if (!localAddress) return '';
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address === localAddress) return name;
    }
  }
  return '';
}

export interface MobileLanServerDeps {
  app: MobileHostApplication;
  hostStaticKey: KeyPair;
  onLog?: (line: string) => void;
}

export class MobileLanServer {
  private server?: net.Server;
  private policy: MobileAccessPolicy = { mode: 'off', allowedInterfaces: [], allowedSubnets: [] };
  private boundPort?: number;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly deps: MobileLanServerDeps) {}

  get listening(): boolean {
    return this.server !== undefined;
  }

  get port(): number | undefined {
    return this.boundPort;
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  async start(port: number, policy: MobileAccessPolicy): Promise<void> {
    if (this.server && port !== 0 && this.boundPort === port) {
      this.policy = policy;
      return;
    }
    await this.stop();
    this.policy = policy;
    const server = net.createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : port;
    this.deps.onLog?.(`[mobile] LAN listener bound on ${this.boundPort} (${policy.mode}).`);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  applyPolicy(policy: MobileAccessPolicy, dropConnections: boolean): void {
    this.policy = policy;
    if (dropConnections) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    }
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    const channel = SecureChannel.responder({ staticKeyPair: this.deps.hostStaticKey });
    const assembler = new RecordAssembler();
    let flushed = 0;
    let authorised = false;

    const sendSecure = (frame: ServerFrame): void => {
      if (!socket.destroyed) socket.write(channel.encrypt(encode(frame)));
    };
    const flushEvents = (): void => {
      for (const envelope of this.deps.app.ledger.replay(flushed)) {
        sendSecure({ kind: 'event', envelope });
        flushed = Math.max(flushed, envelope.sequence);
      }
    };

    const peerContext = (): MobilePeerContext => ({
      interfaceName: interfaceNameFor(socket.localAddress),
      remoteAddress: socket.remoteAddress ?? '',
      authenticated: true,
      relayRoute: false,
    });

    const handle = async (request: RequestFrame): Promise<ReplyFrame> => {
      try {
        if (request.kind === 'replay') {
          const after = Number((request.payload as { afterSequence?: unknown } | undefined)?.afterSequence ?? 0);
          flushed = Number.isFinite(after) ? after : 0;
          return { id: request.id, kind: 'reply', ok: true, value: { replaying: true } };
        }
        const value =
          request.kind === 'command'
            ? await handleMobileCommand(this.deps.app, request.payload as MobileCommand)
            : await handleMobileRead(this.deps.app, request.payload as MobileReadRequest);
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
          try {
            channel.readHandshakeMessage(record);
            if (!channel.open) socket.write(channel.nextHandshakeMessage());
          } catch (error) {
            this.deps.onLog?.(`[mobile] handshake rejected: ${error instanceof Error ? error.message : String(error)}`);
            socket.destroy();
            return;
          }
          if (channel.open) {
            const decision = evaluateMobileAccess(this.policy, peerContext());
            if (!decision.allowed) {
              this.deps.onLog?.(`[mobile] peer refused (${decision.reason}).`);
              socket.destroy();
              return;
            }
            authorised = true;
          }
          continue;
        }
        if (!authorised) {
          socket.destroy();
          return;
        }
        let request: RequestFrame;
        try {
          request = decode<RequestFrame>(channel.decrypt(record));
        } catch {
          socket.destroy();
          return;
        }
        void handle(request).then(reply => {
          flushEvents();
          sendSecure(reply);
        });
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }
}
