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
import { createHash } from 'node:crypto';
import {
  evaluateMobileAccess,
  handleMobileCommand,
  handleMobileRead,
  type MobileAccessPolicy,
  type MobileCommand,
  type MobileCaller,
  type MobileCapability,
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

export interface MobileLanAuthorizedPeer {
  deviceId: string;
  capabilities: readonly MobileCapability[];
  projectIds?: readonly string[];
}

export interface MobileLanServerDeps {
  app: MobileHostApplication;
  hostStaticKey: KeyPair;
  pairingCode?: string;
  authorizePeer?: (publicKeyHex: string) => MobileLanAuthorizedPeer | undefined;
  /** When a handshake completes for an unknown key: keep the socket for confirmation, or refuse. */
  onUnpairedPeer?: (publicKeyHex: string) => 'pending' | 'refuse';
  onLog?: (line: string) => void;
}

interface TrackedPeer {
  socket: net.Socket;
  publicKeyHex?: string;
  deviceId?: string;
  attach: (peer: { caller: MobileCaller; projectIds?: readonly string[] }) => void;
}

const toHex = (value: Uint8Array): string => [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');

function authenticatedCaller(publicKey: Uint8Array): MobileCaller {
  const digest = createHash('sha256').update(publicKey).digest('hex').slice(0, 24);
  return { deviceId: `device:${digest}`, capabilities: ['view', 'execute', 'approve'] };
}

export class MobileLanServer {
  private server?: net.Server;
  private policy: MobileAccessPolicy = { mode: 'off', allowedInterfaces: [], allowedSubnets: [] };
  private boundPort?: number;
  private lastError?: string;
  private readonly peers = new Set<TrackedPeer>();

  constructor(private readonly deps: MobileLanServerDeps) {}

  get listening(): boolean {
    return this.server !== undefined;
  }

  get port(): number | undefined {
    return this.boundPort;
  }

  get bindError(): string | undefined {
    return this.lastError;
  }

  connectionCount(): number {
    return this.peers.size;
  }

  async start(port: number, policy: MobileAccessPolicy): Promise<void> {
    if (this.server && port !== 0 && this.boundPort === port) {
      this.policy = policy;
      this.lastError = undefined;
      return;
    }
    await this.stop();
    this.policy = policy;
    const server = net.createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', error => {
        this.lastError = error instanceof Error ? error.message : String(error);
        reject(error);
      });
      server.listen(port, () => {
        server.off('error', reject);
        this.lastError = undefined;
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : port;
    this.deps.onLog?.(`[mobile] LAN listener bound on ${this.boundPort} (${policy.mode}).`);
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.destroy();
    this.peers.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  applyPolicy(policy: MobileAccessPolicy, dropConnections: boolean): void {
    this.policy = policy;
    if (dropConnections) this.dropAll();
  }

  dropAll(): void {
    for (const peer of this.peers) peer.socket.destroy();
    this.peers.clear();
  }

  dropDevice(deviceId: string): number {
    let dropped = 0;
    for (const peer of [...this.peers]) {
      if (peer.deviceId === deviceId) {
        peer.socket.destroy();
        this.peers.delete(peer);
        dropped += 1;
      }
    }
    return dropped;
  }

  dropPublicKey(publicKeyHex: string): number {
    const needle = publicKeyHex.toLowerCase();
    let dropped = 0;
    for (const peer of [...this.peers]) {
      if (peer.publicKeyHex?.toLowerCase() === needle) {
        peer.socket.destroy();
        this.peers.delete(peer);
        dropped += 1;
      }
    }
    return dropped;
  }

  promotePending(publicKeyHex: string, allowed: MobileLanAuthorizedPeer): void {
    const needle = publicKeyHex.toLowerCase();
    for (const peer of this.peers) {
      if (peer.publicKeyHex?.toLowerCase() !== needle) continue;
      peer.deviceId = allowed.deviceId;
      peer.attach({
        caller: { deviceId: allowed.deviceId, capabilities: allowed.capabilities },
        ...(allowed.projectIds ? { projectIds: allowed.projectIds } : {}),
      });
    }
  }

  private accept(socket: net.Socket): void {
    const channel = SecureChannel.responder({
      staticKeyPair: this.deps.hostStaticKey,
      ...(this.deps.pairingCode ? { prologue: new TextEncoder().encode(this.deps.pairingCode) } : {}),
    });
    const assembler = new RecordAssembler();
    let flushed = 0;
    let authorised = false;
    let pairingHold = false;
    let peer: { caller: MobileCaller; projectIds?: readonly string[] } | undefined;
    let eventTimer: NodeJS.Timeout | undefined;
    const tracked: TrackedPeer = {
      socket,
      attach: next => {
        peer = next;
        authorised = true;
        pairingHold = false;
      },
    };
    this.peers.add(tracked);

    const sendSecure = (frame: ServerFrame): void => {
      if (!socket.destroyed) socket.write(channel.encrypt(encode(frame)));
    };
    const flushEvents = (): void => {
      for (const envelope of this.deps.app.ledger.replay(flushed)) {
        flushed = Math.max(flushed, envelope.sequence);
        if (peer?.projectIds?.length && envelope.target.projectId && !peer.projectIds.includes(envelope.target.projectId)) continue;
        sendSecure({ kind: 'event', envelope });
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
        if (!peer) throw new Error(pairingHold ? 'This phone is waiting for confirmation on the desktop.' : 'The mobile device is not authenticated.');
        const supplied = request.payload as MobileCommand | MobileReadRequest;
        const projectId = supplied.target?.projectId;
        if (projectId && peer.projectIds?.length && !peer.projectIds.includes(projectId)) {
          throw new Error(`The mobile device is not authorised for project ${projectId}.`);
        }
        const authenticated = { ...supplied, caller: peer.caller } as MobileCommand | MobileReadRequest;
        const value =
          request.kind === 'command'
            ? await handleMobileCommand(this.deps.app, authenticated as MobileCommand)
            : await handleMobileRead(this.deps.app, authenticated as MobileReadRequest);
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
            const publicKey = channel.peerStaticPublicKey;
            if (!publicKey) {
              socket.destroy();
              return;
            }
            const publicKeyHex = toHex(publicKey);
            tracked.publicKeyHex = publicKeyHex;
            const allowed = this.deps.authorizePeer?.(publicKeyHex);
            if (this.deps.authorizePeer && !allowed) {
              const unpaired = this.deps.onUnpairedPeer?.(publicKeyHex) ?? 'refuse';
              if (unpaired === 'refuse') {
                this.deps.onLog?.('[mobile] unpaired device refused.');
                socket.destroy();
                return;
              }
              pairingHold = true;
              this.deps.onLog?.('[mobile] unpaired device waiting for confirmation.');
              eventTimer = setInterval(flushEvents, 50);
              continue;
            }
            peer = allowed
              ? { caller: { deviceId: allowed.deviceId, capabilities: allowed.capabilities }, ...(allowed.projectIds ? { projectIds: allowed.projectIds } : {}) }
              : { caller: authenticatedCaller(publicKey) };
            tracked.deviceId = peer.caller.deviceId;
            authorised = true;
            eventTimer = setInterval(flushEvents, 50);
          }
          continue;
        }
        if (!authorised && !pairingHold) {
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
    const cleanUp = (): void => {
      if (eventTimer) clearInterval(eventTimer);
      this.peers.delete(tracked);
    };
    socket.on('close', cleanUp);
    socket.on('error', cleanUp);
  }
}
