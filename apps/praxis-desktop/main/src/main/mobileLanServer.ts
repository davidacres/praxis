/**
 * The real LAN listener (FX-BE-077): a TCP server that runs the Noise `IK`
 * handshake with each peer (this side is the responder), authorises the
 * authenticated peer against the access policy, then serves encrypted mobile
 * read/command frames through the same `handleMobileRead` / `handleMobileCommand`
 * the IPC bridge uses. Events the host emits are pushed to connected peers.
 *
 * Framing above the Noise channel (frame ids, a `replay` request, pushed
 * `event` records, `status` frames) is `@praxis/mobile-protocol`'s wire. Every
 * accepted channel first receives a status: `ready`, `pairing-required` (an
 * unknown phone must present its invitation token in a `pair` frame), or a
 * refusal sent *before* the socket closes so the phone can show the reason.
 * A new peer receives only events appended after it is authorised; it asks
 * for anything earlier with `replay`.
 */
import * as net from 'node:net';
import * as os from 'node:os';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  evaluateMobileAccess,
  handleMobileCommand,
  handleMobileRead,
  type MobileAccessPolicy,
  type MobileCommand,
  type MobileCaller,
  type MobileCapability,
  type MobileHostApplication,
  type MobilePeerContext,
  type MobileReadRequest,
} from '@praxis/core';
import {
  RecordAssembler,
  SecureChannel,
  mobileConnectionStatus,
  type KeyPair,
  type MobileConnectionStatus,
  type MobileEventFrame,
  type MobileReplyFrame,
  type MobileRequestFrame,
  type MobileServerFrame,
} from '@praxis/mobile-protocol';

type RequestFrame = MobileRequestFrame;
type ReplyFrame = MobileReplyFrame;

type ServerFrame = MobileServerFrame;

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
  /**
   * An unknown key completed the handshake (no `tokenId`) or presented an
   * invitation token. Returns the status to send: `pairing-required` and
   * `pairing-pending` hold the socket open; anything else is a refusal and
   * closes it. Absent: unknown keys are told `pairing-required` and closed.
   */
  onUnpairedPeer?: (publicKeyHex: string, tokenId?: string) => MobileConnectionStatus;
  onLog?: (line: string) => void;
}

/**
 * What the listener needs from a connection: a `net.Socket`, or a relayed
 * stream (`MobileRelayStream`) carrying the same bytes through the relay.
 */
export type MobileStream = Duplex & { localAddress?: string; remoteAddress?: string };

interface TrackedPeer {
  socket: MobileStream;
  publicKeyHex?: string;
  deviceId?: string;
  attach: (peer: { caller: MobileCaller; projectIds?: readonly string[] }) => void;
  /** Sends `status` (when the channel is open) and closes the socket. */
  closeWith: (status: MobileConnectionStatus) => void;
}

/** Status for a peer the access policy refused. */
function refusalFor(reason: string): MobileConnectionStatus {
  if (reason === 'disabled') return mobileConnectionStatus('access-disabled');
  if (reason === 'interface-not-allowed' || reason === 'address-not-allowed') {
    return mobileConnectionStatus('access-denied', 'The desktop’s mobile access policy does not allow this network or address. Check the allowed interfaces and subnets in Settings → Mobile access.');
  }
  return mobileConnectionStatus('access-denied');
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
    const server = net.createServer(socket => this.accept(socket, false));
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
    for (const peer of [...this.peers]) {
      peer.closeWith(mobileConnectionStatus('host-shutdown'));
      peer.socket.destroy();
    }
    this.peers.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (server) {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          resolve();
        }, 500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  applyPolicy(policy: MobileAccessPolicy, dropConnections: boolean): void {
    this.policy = policy;
    if (dropConnections) {
      this.dropAll(policy.mode === 'off'
        ? mobileConnectionStatus('access-disabled')
        : mobileConnectionStatus('host-shutdown', 'The desktop changed its mobile access settings. Reconnecting…'));
    }
  }

  dropAll(status: MobileConnectionStatus = mobileConnectionStatus('host-shutdown')): void {
    for (const peer of this.peers) peer.closeWith(status);
    this.peers.clear();
  }

  dropDevice(deviceId: string, status: MobileConnectionStatus = mobileConnectionStatus('device-revoked')): number {
    let dropped = 0;
    for (const peer of [...this.peers]) {
      if (peer.deviceId === deviceId) {
        peer.closeWith(status);
        this.peers.delete(peer);
        dropped += 1;
      }
    }
    return dropped;
  }

  dropPublicKey(publicKeyHex: string, status: MobileConnectionStatus = mobileConnectionStatus('pairing-rejected')): number {
    const needle = publicKeyHex.toLowerCase();
    let dropped = 0;
    for (const peer of [...this.peers]) {
      if (peer.publicKeyHex?.toLowerCase() === needle) {
        peer.closeWith(status);
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

  /**
   * Serves a stream that arrived through the relay. It runs the same Noise IK
   * handshake, pairing and authorisation as a LAN peer; the only difference is
   * that the access policy sees `relayRoute: true`, which only `internet` mode
   * admits, and the listener need not be bound for it.
   */
  acceptRelayedStream(stream: MobileStream): void {
    this.accept(stream, true);
  }

  private accept(socket: MobileStream, relay: boolean): void {
    const channel = SecureChannel.responder({
      staticKeyPair: this.deps.hostStaticKey,
      ...(this.deps.pairingCode ? { prologue: new TextEncoder().encode(this.deps.pairingCode) } : {}),
    });
    const assembler = new RecordAssembler();
    const ledger = this.deps.app.ledger;
    let flushed = 0;
    let authorised = false;
    let pairingHold = false;
    let closing = false;
    let peer: { caller: MobileCaller; projectIds?: readonly string[] } | undefined;
    let eventTimer: NodeJS.Timeout | undefined;

    const sendSecure = (frame: ServerFrame): void => {
      if (!socket.destroyed && !closing && channel.open) socket.write(channel.encrypt(encode(frame)));
    };
    const flushEvents = (): void => {
      if (!peer || closing) return;
      for (const envelope of ledger.replay(flushed)) {
        flushed = Math.max(flushed, envelope.sequence);
        const hostWide = (envelope.event as { type?: string } | undefined)?.type === 'host.appearance';
        if (!hostWide && peer.projectIds?.length && (!envelope.target.projectId || !peer.projectIds.includes(envelope.target.projectId))) continue;
        sendSecure({ kind: 'event', envelope: envelope as unknown as MobileEventFrame['envelope'] });
      }
    };
    const closeWith = (status: MobileConnectionStatus): void => {
      if (closing || socket.destroyed) return;
      sendSecure({ kind: 'status', status });
      closing = true;
      if (eventTimer) clearInterval(eventTimer);
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
    };
    const tracked: TrackedPeer = {
      socket,
      closeWith,
      attach: next => {
        peer = next;
        authorised = true;
        pairingHold = false;
        tracked.deviceId = next.caller.deviceId;
        // Live from here on; anything earlier is fetched with an explicit replay.
        flushed = ledger.latestSequence();
        sendSecure({ kind: 'status', status: mobileConnectionStatus('ready') });
        if (!eventTimer) eventTimer = setInterval(flushEvents, 50);
      },
    };
    this.peers.add(tracked);

    const peerContext = (): MobilePeerContext => ({
      interfaceName: interfaceNameFor(socket.localAddress),
      remoteAddress: socket.remoteAddress ?? '',
      authenticated: true,
      relayRoute: relay,
    });

    const holdOrClose = (status: MobileConnectionStatus): void => {
      if (status.code === 'pairing-required' || status.code === 'pairing-pending') {
        pairingHold = true;
        sendSecure({ kind: 'status', status });
        this.deps.onLog?.(`[mobile] unpaired device ${status.code === 'pairing-pending' ? 'waiting for confirmation' : 'asked for an invitation'}.`);
        return;
      }
      this.deps.onLog?.(`[mobile] unpaired device refused (${status.code}).`);
      this.peers.delete(tracked);
      closeWith(status);
    };

    const handle = async (request: RequestFrame): Promise<ReplyFrame | undefined> => {
      try {
        if (request.kind === 'pair') {
          if (peer) return { id: request.id, kind: 'reply', ok: true, value: { paired: true } };
          const tokenId = (request.payload as { tokenId?: unknown } | undefined)?.tokenId;
          const status = this.deps.onUnpairedPeer && tracked.publicKeyHex
            ? this.deps.onUnpairedPeer(tracked.publicKeyHex, typeof tokenId === 'string' ? tokenId : '')
            : mobileConnectionStatus('pairing-required');
          holdOrClose(status);
          return undefined;
        }
        if (!peer) {
          return pairingHold
            ? { id: request.id, kind: 'reply', ok: false, code: 'pairing-pending', error: 'This phone is waiting for confirmation on the desktop.' }
            : { id: request.id, kind: 'reply', ok: false, code: 'not-authorised', error: 'The mobile device is not authenticated.' };
        }
        if (request.kind === 'replay') {
          const requested = Number((request.payload as { afterSequence?: unknown } | undefined)?.afterSequence ?? 0);
          const after = Number.isFinite(requested) && requested >= 0 ? requested : 0;
          const oldest = ledger.oldestRetainedSequence();
          flushed = Math.max(after, 0);
          return {
            id: request.id,
            kind: 'reply',
            ok: true,
            value: { replaying: true, latestSequence: ledger.latestSequence(), ...(after < oldest - 1 ? { truncated: true } : {}) },
          };
        }
        const supplied = request.payload as MobileCommand | MobileReadRequest;
        const projectId = supplied.target?.projectId;
        const unscoped = supplied.operation === 'hosts.list' || supplied.operation === 'projects.snapshot' || supplied.operation === 'host.info' || supplied.operation === 'providers.list' || supplied.operation === 'models.list' || supplied.operation === 'access.get';
        if (peer.projectIds?.length && !unscoped && !projectId) {
          throw new Error('This operation requires an authorised project.');
        }
        if (projectId && peer.projectIds?.length && !peer.projectIds.includes(projectId)) {
          throw new Error(`The mobile device is not authorised for project ${projectId}.`);
        }
        if (request.kind === 'read' && !this.deps.app.reads[supplied.operation]) {
          return { id: request.id, kind: 'reply', ok: false, code: 'unsupported-operation', error: `This desktop does not support ${supplied.operation}. Update Praxis on the desktop.` };
        }
        const authenticated = { ...supplied, caller: peer.caller } as MobileCommand | MobileReadRequest;
        let value =
          request.kind === 'command'
            ? await handleMobileCommand(this.deps.app, authenticated as MobileCommand)
            : await handleMobileRead(this.deps.app, authenticated as MobileReadRequest);
        if (
          supplied.operation === 'projects.snapshot' &&
          !projectId &&
          peer.projectIds?.length &&
          value && typeof value === 'object' && Array.isArray((value as { projects?: unknown }).projects)
        ) {
          const projects = (value as { projects: Array<{ projectId?: string }> }).projects;
          value = { projects: projects.filter(project => project.projectId && peer?.projectIds?.includes(project.projectId)) };
        }
        return { id: request.id, kind: 'reply', ok: true, value };
      } catch (error) {
        return { id: request.id, kind: 'reply', ok: false, code: 'rejected', error: error instanceof Error ? error.message : String(error) };
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (closing) return;
      let records: Uint8Array[];
      try {
        records = assembler.push(chunk);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const record of records) {
        if (closing) return;
        if (!channel.open) {
          try {
            channel.readHandshakeMessage(record);
            if (!channel.open) socket.write(channel.nextHandshakeMessage());
          } catch (error) {
            // Nothing can be sent: without a completed handshake there is no key
            // to encrypt a reason with. The phone reports a handshake rejection.
            this.deps.onLog?.(`[mobile] handshake rejected: ${error instanceof Error ? error.message : String(error)}`);
            socket.destroy();
            return;
          }
          if (channel.open) {
            const decision = evaluateMobileAccess(this.policy, peerContext());
            if (!decision.allowed) {
              this.deps.onLog?.(`[mobile] peer refused (${decision.reason}).`);
              this.peers.delete(tracked);
              closeWith(refusalFor(decision.reason));
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
              holdOrClose(this.deps.onUnpairedPeer?.(publicKeyHex) ?? mobileConnectionStatus('pairing-required'));
              if (!pairingHold) return;
              continue;
            }
            tracked.attach(allowed
              ? { caller: { deviceId: allowed.deviceId, capabilities: allowed.capabilities }, ...(allowed.projectIds ? { projectIds: allowed.projectIds } : {}) }
              : { caller: authenticatedCaller(publicKey) });
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
          if (reply) sendSecure(reply);
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
