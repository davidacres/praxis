/**
 * The desktop's outbound relay connection (FX-BE-079, TASK-390).
 *
 * The desktop holds one control socket to the relay, proves it owns its channel
 * by signing the relay's challenge, and when a phone connects the relay says
 * `incoming`; the desktop then opens a second socket for that phone and hands it
 * to the LAN listener as a stream. Nothing is inbound: no port is forwarded and
 * no account exists. Stopping the client closes the control socket, which makes
 * the relay close every phone it was piping to us.
 */
import { sign, type KeyObject } from 'node:crypto';
import { RELAY_SIGNATURE_CONTEXT } from '@praxis/mobile-relay';
import WebSocket from 'ws';
import { MobileRelayStream } from './mobileRelayStream';

export type MobileRelayState = 'stopped' | 'connecting' | 'registered' | 'error';

export interface MobileRelayIdentity {
  /** Raw Ed25519 public key, 64 hex characters. */
  publicKeyHex: string;
  privateKey: KeyObject;
}

export interface MobileRelayClientOptions {
  /** `wss://relay.example.com` (or `ws://` for a local relay). */
  relayUrl: string;
  identity: MobileRelayIdentity;
  /** A phone's relayed connection, ready to serve. */
  onStream: (stream: MobileRelayStream) => void;
  onLog?: (line: string) => void;
  /** The state or channel changed (registered, lost, stopped). */
  onStateChange?: () => void;
  /** Reconnect backoff bounds, milliseconds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export class MobileRelayClient {
  private control?: WebSocket;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private stopped = true;
  private currentState: MobileRelayState = 'stopped';
  private currentChannel?: string;
  private lastError?: string;
  private readonly accepting = new Set<WebSocket>();

  constructor(private readonly options: MobileRelayClientOptions) {}

  get state(): MobileRelayState {
    return this.currentState;
  }

  /** The relay channel id once registered; what the QR carries. */
  get channel(): string | undefined {
    return this.currentChannel;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.control?.terminate();
    this.control = undefined;
    for (const socket of this.accepting) socket.terminate();
    this.accepting.clear();
    this.currentState = 'stopped';
    this.currentChannel = undefined;
    this.options.onStateChange?.();
  }

  private base(): string {
    return this.options.relayUrl.replace(/\/+$/, '');
  }

  private connect(): void {
    this.currentState = 'connecting';
    const control = new WebSocket(`${this.base()}/v1/host?key=${this.options.identity.publicKeyHex}`);
    this.control = control;
    control.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: { type?: string; nonce?: string; channel?: string; conn?: string };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'challenge' && typeof message.nonce === 'string') {
        const signature = sign(null, Buffer.from(RELAY_SIGNATURE_CONTEXT + message.nonce, 'utf8'), this.options.identity.privateKey).toString('hex');
        control.send(JSON.stringify({ type: 'auth', signature }));
      } else if (message.type === 'registered' && typeof message.channel === 'string') {
        this.currentState = 'registered';
        this.currentChannel = message.channel;
        this.lastError = undefined;
        this.attempt = 0;
        this.options.onLog?.('[mobile] registered with the relay.');
        this.options.onStateChange?.();
      } else if (message.type === 'incoming' && typeof message.conn === 'string') {
        this.accept(message.conn);
      }
    });
    control.on('error', error => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    control.on('close', code => {
      if (this.control !== control) return;
      this.control = undefined;
      this.currentChannel = undefined;
      if (this.stopped) return;
      this.currentState = 'error';
      this.lastError ??= `The relay closed the connection (${code}).`;
      this.options.onLog?.(`[mobile] relay connection lost (${code}); retrying.`);
      this.options.onStateChange?.();
      this.scheduleReconnect();
    });
  }

  private accept(conn: string): void {
    const channel = this.currentChannel;
    if (!channel) return;
    const ws = new WebSocket(`${this.base()}/v1/accept?channel=${channel}&conn=${conn}`);
    this.accepting.add(ws);
    ws.once('open', () => {
      this.accepting.delete(ws);
      this.options.onStream(new MobileRelayStream(ws));
    });
    ws.once('error', () => this.accepting.delete(ws));
    ws.once('close', () => this.accepting.delete(ws));
  }

  private scheduleReconnect(): void {
    const min = this.options.minBackoffMs ?? 1000;
    const max = this.options.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.connect();
    }, delay);
    this.timer.unref();
  }
}
