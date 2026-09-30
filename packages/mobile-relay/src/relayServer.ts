/**
 * The Praxis mobile relay (FX-BE-079, TASK-217).
 *
 * Two outbound connections meet here; the relay forwards bytes between them and
 * cannot read them — the Noise IK channel runs end to end above it, so the relay
 * is untrusted. There are no accounts: a host proves it owns a channel by
 * signing a challenge with an Ed25519 key, and the channel id *is* the hash of
 * that key, so nobody can register a channel they do not hold the key for.
 *
 *   host    GET /v1/host?key=<64 hex>        control socket; challenge → auth → registered
 *   phone   GET /v1/connect?channel=<hex>    relay tells the host `incoming`; phone bytes wait
 *   host    GET /v1/accept?channel=&conn=    second socket for that one phone; the two are piped
 *
 * The phone is not authenticated *to the relay* — the host authenticates it with
 * Noise IK and its own pairing rules. What the relay does defend is itself:
 * per-channel and per-address caps, a handshake timeout, bounded buffering, a
 * message-size cap and a per-connection byte-rate limit.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_SIGNATURE_CONTEXT = 'praxis-relay-v1|';

/** Close codes the relay uses; 4xxx is the application range. */
export const RELAY_CLOSE = {
  badRequest: 4400,
  authFailed: 4401,
  hostOffline: 4404,
  waitTimeout: 4408,
  replaced: 4409,
  tooManyPeers: 4429,
  rateLimited: 4430,
  serverBusy: 4503,
} as const;

export interface RelayLimits {
  maxChannels: number;
  maxDevicesPerChannel: number;
  maxPendingPerChannel: number;
  /** Concurrent sockets from one remote address. */
  maxSocketsPerAddress: number;
  /** New sockets per address per minute. */
  maxConnectsPerMinute: number;
  /** A ws message larger than this closes the socket (Noise record limit is 1 MiB). */
  maxMessageBytes: number;
  /** Bytes a phone may send before the host's accept socket attaches. */
  maxBufferedBytes: number;
  authTimeoutMs: number;
  acceptTimeoutMs: number;
  /** Sustained bytes/second per piped connection, in each direction. */
  bytesPerSecond: number;
  burstBytes: number;
  heartbeatMs: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxChannels: 1000,
  maxDevicesPerChannel: 8,
  maxPendingPerChannel: 4,
  maxSocketsPerAddress: 32,
  maxConnectsPerMinute: 60,
  maxMessageBytes: (1 << 20) + 1024,
  maxBufferedBytes: 256 * 1024,
  authTimeoutMs: 10_000,
  acceptTimeoutMs: 20_000,
  bytesPerSecond: 4 * 1024 * 1024,
  burstBytes: 8 * 1024 * 1024,
  heartbeatMs: 30_000,
};

export interface RelayServerOptions {
  port?: number;
  host?: string;
  limits?: Partial<RelayLimits>;
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Diagnostic lines. Never receives payloads or keys. */
  onLog?: (line: string) => void;
}

interface Piped {
  conn: string;
  device: WebSocket;
  accept?: WebSocket;
  buffered: Buffer[];
  bufferedBytes: number;
  timer?: NodeJS.Timeout;
}

interface Channel {
  id: string;
  control: WebSocket;
  pending: Map<string, Piped>;
  active: Set<Piped>;
}

/** SPKI DER prefix for a raw Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_CHANNEL = /^[0-9a-f]{32}$/;
const HEX_CONN = /^[0-9a-f]{32}$/;

/** The channel id for a host's Ed25519 public key. */
export function channelIdForKey(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 32);
}

export function verifyHostSignature(publicKeyHex: string, nonceHex: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(RELAY_SIGNATURE_CONTEXT + nonceHex, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

class ByteBudget {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly perSecond: number, private readonly burst: number) {
    this.tokens = burst;
  }
  take(bytes: number): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
}

export class RelayServer {
  private readonly limits: RelayLimits;
  private readonly channels = new Map<string, Channel>();
  private readonly socketsByAddress = new Map<string, number>();
  private readonly connectsByAddress = new Map<string, number[]>();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly alive = new WeakMap<WebSocket, boolean>();

  constructor(private readonly options: RelayServerOptions = {}) {
    this.limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : undefined;
  }

  channelCount(): number {
    return this.channels.size;
  }

  async start(): Promise<void> {
    const handler: http.RequestListener = (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('praxis-relay');
    };
    const server = this.options.tls ? https.createServer(this.options.tls, handler) : http.createServer(handler);
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxMessageBytes });
    server.on('upgrade', (req, socket, head) => {
      const address = req.socket.remoteAddress ?? 'unknown';
      if (!this.admit(address)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        this.trackSocket(ws, address);
        this.route(ws, req);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    this.heartbeat = setInterval(() => this.beat(), this.limits.heartbeatMs);
    this.heartbeat.unref();
    this.options.onLog?.(`relay listening on ${this.port}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.channels.clear();
    const server = this.server;
    this.server = undefined;
    this.wss?.close();
    if (server) {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  /** Per-address connection-rate and concurrency admission. */
  private admit(address: string): boolean {
    const now = Date.now();
    const recent = (this.connectsByAddress.get(address) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.limits.maxConnectsPerMinute) {
      this.connectsByAddress.set(address, recent);
      return false;
    }
    if ((this.socketsByAddress.get(address) ?? 0) >= this.limits.maxSocketsPerAddress) return false;
    recent.push(now);
    this.connectsByAddress.set(address, recent);
    return true;
  }

  private trackSocket(ws: WebSocket, address: string): void {
    this.socketsByAddress.set(address, (this.socketsByAddress.get(address) ?? 0) + 1);
    this.alive.set(ws, true);
    ws.on('pong', () => this.alive.set(ws, true));
    ws.once('close', () => {
      const left = (this.socketsByAddress.get(address) ?? 1) - 1;
      if (left <= 0) this.socketsByAddress.delete(address);
      else this.socketsByAddress.set(address, left);
    });
  }

  private beat(): void {
    for (const client of this.wss?.clients ?? []) {
      if (this.alive.get(client) === false) {
        client.terminate();
        continue;
      }
      this.alive.set(client, false);
      client.ping();
    }
    const now = Date.now();
    for (const [address, times] of this.connectsByAddress) {
      const recent = times.filter(at => now - at < 60_000);
      if (recent.length) this.connectsByAddress.set(address, recent);
      else this.connectsByAddress.delete(address);
    }
  }

  private route(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://relay');
    ws.on('error', () => undefined);
    switch (url.pathname) {
      case '/v1/host':
        return this.onHost(ws, (url.searchParams.get('key') ?? '').toLowerCase());
      case '/v1/connect':
        return this.onDevice(ws, (url.searchParams.get('channel') ?? '').toLowerCase());
      case '/v1/accept':
        return this.onAccept(ws, (url.searchParams.get('channel') ?? '').toLowerCase(), (url.searchParams.get('conn') ?? '').toLowerCase());
      default:
        ws.close(RELAY_CLOSE.badRequest, 'unknown path');
    }
  }

  private onHost(ws: WebSocket, keyHex: string): void {
    if (!HEX_KEY.test(keyHex)) return void ws.close(RELAY_CLOSE.badRequest, 'bad key');
    const nonce = randomBytes(32).toString('hex');
    let authed = false;
    const timer = setTimeout(() => ws.close(RELAY_CLOSE.authFailed, 'auth timeout'), this.limits.authTimeoutMs);
    ws.send(JSON.stringify({ type: 'challenge', version: RELAY_PROTOCOL_VERSION, nonce }));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (authed || isBinary) return void ws.close(RELAY_CLOSE.badRequest, 'unexpected message');
      let message: { type?: unknown; signature?: unknown };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return void ws.close(RELAY_CLOSE.badRequest, 'bad json');
      }
      if (message.type !== 'auth' || typeof message.signature !== 'string' || !verifyHostSignature(keyHex, nonce, message.signature)) {
        return void ws.close(RELAY_CLOSE.authFailed, 'auth failed');
      }
      const id = channelIdForKey(keyHex);
      if (!this.channels.has(id) && this.channels.size >= this.limits.maxChannels) {
        return void ws.close(RELAY_CLOSE.serverBusy, 'relay full');
      }
      authed = true;
      clearTimeout(timer);
      this.channels.get(id)?.control.close(RELAY_CLOSE.replaced, 'replaced by a newer registration');
      const channel: Channel = { id, control: ws, pending: new Map(), active: new Set() };
      this.channels.set(id, channel);
      ws.send(JSON.stringify({ type: 'registered', channel: id }));
      this.options.onLog?.(`channel ${id.slice(0, 8)} registered`);
    });
    ws.once('close', () => {
      clearTimeout(timer);
      if (!authed) return;
      const id = channelIdForKey(keyHex);
      const channel = this.channels.get(id);
      if (channel?.control !== ws) return;
      this.channels.delete(id);
      for (const piped of [...channel.pending.values(), ...channel.active]) {
        piped.device.close(RELAY_CLOSE.hostOffline, 'host went offline');
        piped.accept?.close(RELAY_CLOSE.hostOffline, 'host went offline');
      }
    });
  }

  private onDevice(ws: WebSocket, channelId: string): void {
    const channel = HEX_CHANNEL.test(channelId) ? this.channels.get(channelId) : undefined;
    if (!channel) return void ws.close(RELAY_CLOSE.hostOffline, 'host offline');
    if (channel.pending.size >= this.limits.maxPendingPerChannel || channel.pending.size + channel.active.size >= this.limits.maxDevicesPerChannel) {
      return void ws.close(RELAY_CLOSE.tooManyPeers, 'too many connections for this host');
    }
    const piped: Piped = { conn: randomBytes(16).toString('hex'), device: ws, buffered: [], bufferedBytes: 0 };
    channel.pending.set(piped.conn, piped);
    piped.timer = setTimeout(() => ws.close(RELAY_CLOSE.waitTimeout, 'host did not answer'), this.limits.acceptTimeoutMs);
    const budget = new ByteBudget(this.limits.bytesPerSecond, this.limits.burstBytes);
    ws.on('message', (data: RawData) => {
      const chunk = toBuffer(data);
      if (!budget.take(chunk.length)) return void ws.close(RELAY_CLOSE.rateLimited, 'rate limit');
      if (piped.accept) return void forward(piped.accept, chunk);
      if (piped.bufferedBytes + chunk.length > this.limits.maxBufferedBytes) return void ws.close(RELAY_CLOSE.rateLimited, 'buffer limit');
      piped.buffered.push(chunk);
      piped.bufferedBytes += chunk.length;
    });
    ws.once('close', () => {
      if (piped.timer) clearTimeout(piped.timer);
      channel.pending.delete(piped.conn);
      channel.active.delete(piped);
      piped.accept?.close(1000, 'phone disconnected');
    });
    channel.control.send(JSON.stringify({ type: 'incoming', conn: piped.conn }));
  }

  private onAccept(ws: WebSocket, channelId: string, conn: string): void {
    const channel = HEX_CHANNEL.test(channelId) && HEX_CONN.test(conn) ? this.channels.get(channelId) : undefined;
    const piped = channel?.pending.get(conn);
    if (!channel || !piped) return void ws.close(RELAY_CLOSE.badRequest, 'unknown connection');
    channel.pending.delete(conn);
    channel.active.add(piped);
    if (piped.timer) clearTimeout(piped.timer);
    piped.accept = ws;
    const budget = new ByteBudget(this.limits.bytesPerSecond, this.limits.burstBytes);
    ws.on('message', (data: RawData) => {
      const chunk = toBuffer(data);
      if (!budget.take(chunk.length)) return void ws.close(RELAY_CLOSE.rateLimited, 'rate limit');
      forward(piped.device, chunk);
    });
    ws.once('close', () => {
      channel.active.delete(piped);
      piped.device.close(1000, 'host disconnected');
    });
    for (const chunk of piped.buffered) forward(ws, chunk);
    piped.buffered = [];
    piped.bufferedBytes = 0;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function forward(to: WebSocket, chunk: Buffer): void {
  if (to.readyState === to.OPEN) to.send(chunk, { binary: true });
}
